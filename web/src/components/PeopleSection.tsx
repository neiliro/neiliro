import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Empty } from './Page';
import { EntityDialog } from './EntityDialog';
import { inlineDanger, useDialogs } from './Dialog';
import { reportFailure } from '../lib/failures';

interface ManagedUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'kid';
  color: string;
  last_login_at: string | null;
  disabled_at: string | null;
  must_change_password: number;
}

const ROLE_LABEL: Record<ManagedUser['role'], string> = {
  admin: t('Administrator'),
  member: t('Family member'),
  kid: t('Kid'),
};

/** The password is shown exactly once — after that only the owner knows it. */
function PasswordOnce({ password, onClose }: { password: string; onClose: () => void }) {
  return (
    <div className="mb-5 rounded-card border border-accent bg-accent-soft p-4">
      <p className="text-sm font-medium text-ink">{t('Password created. It is shown only once.')}</p>
      <p className="my-3 font-mono text-lg tracking-wide text-ink select-all">{password}</p>
      <p className="text-xs text-muted">
        {t('Hand it to the account owner. On first sign-in they will be asked to set their own password.')}
      </p>
      <button
        type="button"
        onClick={onClose}
        className="mt-3 text-sm font-medium text-accent underline underline-offset-2"
      >
        {t('Recorded, hide')}
      </button>
    </div>
  );
}

interface Invite {
  id: string;
  role: string;
  created_at: string;
  expires_at: string;
  used: number;
  used_by_name: string | null;
}

/**
 * Invite links are the primary way to add a household member:
 * the person fills in their own name, login and password — nothing to dictate.
 * The link is single-use, lives a week and is shown once.
 */
function InvitesBlock() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setInvites(await api.get<Invite[]>('/invites'));
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    try {
      const { path } = await api.post<{ id: string; path: string }>('/invites', {});
      setFreshLink(window.location.origin + path);
      setCopied(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard unavailable (non-HTTPS or denied) — the link is on screen, they'll copy it by hand
    }
  }

  const pending = (invites ?? []).filter((i) => !i.used);

  return (
    <div className="mb-6 rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-4">{t('Invite with a link')}</h2>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('Create link')}
        </button>
        <p className="text-xs text-muted">
          {t('Single-use, valid for a week. Send it to a family member — they fill in the rest themselves.')}
        </p>
      </div>

      {freshLink && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{freshLink}</code>
          <button
            type="button"
            onClick={() => void copy(freshLink)}
            className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface-3"
          >
            {copied ? t('Copied') : t('Copy')}
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <ul className="mt-4 space-y-2">
          {pending.map((i) => (
            <li key={i.id} className="flex items-center justify-between text-sm">
              <span className="text-muted">
                {t('Link from {from} · valid until {to}', { from: i.created_at.slice(0, 10), to: i.expires_at.slice(0, 10) })}
              </span>
              <button
                type="button"
                onClick={() =>
                  void api
                    .delete(`/invites/${i.id}`)
                    .then(load)
                    .catch((err: Error) => reportFailure(err.message || t('Could not save')))
                }
                className={`${inlineDanger} text-xs`}
              >
                {t('Revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * People management, formerly a standalone /users page. User feedback:
 * managing the household happens a few times a year — it does not deserve
 * a navigation item. It now lives in Settings (admin only) and spans both
 * columns there.
 */
export function PeopleSection() {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const dialogs = useDialogs();

  const load = () => api.get<ManagedUser[]>('/users').then(setUsers).catch(() => setUsers([]));
  useEffect(() => {
    void load();
  }, []);

  async function reset(user: ManagedUser) {
    const ok = await dialogs.confirm({
      title: t('Reset password'),
      message: t('{name} will be signed out on all devices and given a new password.', { name: user.name }),
      confirmLabel: t('Reset'),
    });
    if (!ok) return;
    try {
      const res = await api.post<{ password: string }>(`/users/${user.id}/reset-password`, {});
      setPassword(res.password);
      await load();
    } catch (err) {
      reportFailure(err instanceof Error ? err.message : t('Could not save'));
    }
  }

  async function toggle(user: ManagedUser) {
    try {
      await api.post(`/users/${user.id}/toggle`, {});
      await load();
    } catch (err) {
      reportFailure(err instanceof Error ? err.message : t('Could not save'));
    }
  }

  return (
    <section>
      <h2 className="eyebrow mb-4">{t('People')}</h2>
      <InvitesBlock />

      {password && <PasswordOnce password={password} onClose={() => setPassword(null)} />}

      {users === null ? (
        <div className="h-32 animate-pulse rounded-card bg-surface-3" />
      ) : users.length === 0 ? (
        <Empty>{t('No members yet.')}</Empty>
      ) : (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {users.map((u) => (
            <li
              key={u.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3.5 last:border-0"
            >
              {/* Full row on phones: with flex-1 alone the name column
                  shrank to a couple of characters before the actions
                  wrapped ("S…" instead of "Sam") */}
              <div className="flex w-full min-w-0 items-center gap-x-4 sm:w-auto sm:flex-1">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: u.color }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {u.name}
                    {u.disabled_at && <span className="ml-2 text-xs text-muted">{t('disabled')}</span>}
                  </p>
                  <p className="truncate font-mono text-xs text-muted">{u.email}</p>
                </div>
              </div>
              <span className="text-xs text-muted">{ROLE_LABEL[u.role]}</span>
              <button
                type="button"
                onClick={() => setEditing(u)}
                className="text-xs text-accent underline underline-offset-2"
              >
                {t('Edit')}
              </button>
              <button
                type="button"
                onClick={() => void reset(u)}
                className="text-xs text-accent underline underline-offset-2"
              >
                {t('Reset password')}
              </button>
              <button
                type="button"
                onClick={() => void toggle(u)}
                className="text-xs text-muted underline underline-offset-2 hover:text-ink"
              >
                {u.disabled_at ? t('Enable') : t('Disable')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <EntityDialog
          title={t('Member')}
          initial={{ name: editing.name, color: editing.color }}
          onSave={async (draft) => {
            await api.patch(`/users/${editing.id}`, { name: draft.name, color: draft.color });
            await load();
          }}
          onClose={() => setEditing(null)}
        />
      )}

      <p className="mt-5 text-sm text-muted">
        {t('The administrator manages accounts and settings but cannot see anyone’s private notes — queries filter by owner with no exception for the role.')}
      </p>
    </section>
  );
}

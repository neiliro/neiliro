import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useServiceState } from '../lib/service';
import { familyUrl, useFamilyAddress } from '../lib/family-address';
import { formatStamp } from '../lib/format';
import { t } from '../lib/i18n';
import { onEnter } from '../lib/keys';
import { useDialogs } from './Dialog';

/*
  The family's data, admin-only: the complete archive and, on the hosted
  service, the delete-everything button. Both mirror the privacy policy's
  promises; the rules live server-side (routes/family.ts), this is only
  their surface.

  The Danger zone is hosted-only by design. A self-hosted install has one
  family, so the button would mean "erase this whole server" — the person
  who owns the machine does that at the filesystem, not from a web form
  one misclick away from the only copy of the data.
*/

const inputClass =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent';

function startExportDownload() {
  // A plain navigation, not fetch: the browser streams the tar.gz to disk
  // instead of buffering a potentially multi-gigabyte blob in memory.
  window.location.href = '/api/family/export';
}

function ExportCard() {
  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-2">{t('Family archive')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('The complete archive: the database plus every attachment, as one tar.gz. It restores into a self-hosted hub with the import script — your data is never locked in.')}
      </p>
      <button
        type="button"
        onClick={startExportDownload}
        className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2"
      >
        {t('Download the archive')}
      </button>
      <p className="mt-3 text-xs text-muted">
        {t('On a large family this takes a moment — the download starts once the archive is ready.')}
      </p>
    </section>
  );
}

/** The settings card's anchor — the first-sign-in offer links here. */
export const ADDRESS_ANCHOR = 'family-address';

/**
 * The one rename a fresh family gets (routes/family.ts). The card exists
 * only while the offer stands: once the address is changed or the day has
 * passed, there is nothing here to do, so nothing is shown — an address
 * that cannot change is just the URL in the browser.
 */
function AddressCard() {
  const dialogs = useDialogs();
  const address = useFamilyAddress(true);
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const available = Boolean(address?.rename.available);

  // Arriving from the offer dialog: the card is far down an admin's
  // settings page, and it only exists once the answer is in
  useEffect(() => {
    if (available && window.location.hash === `#${ADDRESS_ANCHOR}`) {
      card.current?.scrollIntoView({ block: 'start' });
    }
  }, [available]);

  if (!address || !available) return null;
  const current = familyUrl(address.slug, address.domain);
  // The server validates; this only keeps the field honest as it is typed
  const candidate = slug.trim().toLowerCase();
  const wellFormed = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/.test(candidate);
  const ready = wellFormed && candidate !== address.slug;

  async function rename() {
    if (!address || !ready) return;
    const url = familyUrl(candidate, address.domain);
    const sure = await dialogs.confirm({
      title: t('Move the family to {url}?', { url }),
      message: t('This is the one rename the family gets — there is no second one. Everyone signs in again at the new address, and old links stop working.'),
      confirmLabel: t('Move the family'),
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ url: string }>('/family/rename', { slug: candidate });
      // The session cookie is host-only: the new address starts signed out
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
      setBusy(false);
    }
  }

  return (
    <section
      id={ADDRESS_ANCHOR}
      ref={card}
      className="scroll-mt-4 rounded-card border border-line bg-surface p-5"
    >
      <h2 className="eyebrow mb-2">{t('Hub address')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('Your hub lives at {url}. You can change that once, until {when} — after that the address is permanent.', {
          url: current,
          when: formatStamp(address.rename.until!.slice(0, 19)),
        })}
      </p>

      <div className="max-w-md space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('New address')}</span>
          <div className="flex items-center gap-2">
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              onKeyDown={onEnter(() => void rename())}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={address.slug}
              maxLength={30}
              className={`${inputClass} min-w-0 font-mono`}
            />
            <span className="shrink-0 font-mono text-sm text-muted">.{address.domain}</span>
          </div>
          <span className="mt-1 block text-xs text-muted">
            {t('3–30 lowercase letters, digits and dashes.')}
          </span>
        </label>

        <p className="text-xs text-muted">
          {address.mail
            ? t('Everything moves with the address: everyone signs in again at the new one, old links stop working, and the family mail address becomes {email}.', {
                email: `${candidate || address.slug}@${address.mail}`,
              })
            : t('Everything moves with the address: everyone signs in again at the new one, and old links stop working.')}
        </p>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => void rename()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {t('Change the address…')}
          </button>
          {error && <span className="text-sm text-urgent">{error}</span>}
        </div>
      </div>
    </section>
  );
}

function DangerZone() {
  const { user, logout } = useAuth();
  // The confirmation phrase is the family's subdomain slug — the server
  // verifies it against the registry; this is only the hint in the label.
  const slug = window.location.hostname.split('.')[0] ?? '';
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const needsCode = Boolean(user.totp_enabled);
  const ready =
    password.length > 0 &&
    (!needsCode || code.trim().length >= 6) &&
    confirm.trim().toLowerCase() === slug;

  async function destroy() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/family/delete', {
        password,
        code: needsCode ? code.trim() : undefined,
        confirm: confirm.trim(),
      });
      // The family — sessions included — no longer exists; logout only
      // clears this device's cookie and the offline caches.
      await logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-urgent/40 bg-surface p-5">
      <h2 className="eyebrow mb-2 text-urgent">{t('Danger zone')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('This deletes the family for everyone: the database, every attachment, every account. There is no undo. Encrypted backups expire on their own within 14 days.')}
      </p>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-urgent/40 bg-urgent/10 px-4 py-2 text-sm font-medium text-urgent hover:opacity-90"
        >
          {t('Delete the family…')}
        </button>
      ) : (
        <div className="max-w-md space-y-3">
          <div className="rounded-lg border border-urgent/40 bg-urgent/10 p-3 text-sm text-ink">
            <p className="mb-2 font-medium">
              {t('Download the archive first — once the family is gone, so is the data.')}
            </p>
            <button
              type="button"
              onClick={startExportDownload}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink transition-colors hover:bg-surface-2"
            >
              {t('Download the archive')}
            </button>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">{t('Password')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={inputClass}
            />
          </label>

          {needsCode && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-ink">
                {t('Code from the authenticator app')}
              </span>
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                className={inputClass}
              />
            </label>
          )}

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">
              {t('Type the family address name ({slug}) to confirm', { slug })}
            </span>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              placeholder={slug}
              className={`${inputClass} font-mono`}
            />
          </label>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void destroy()}
              className="rounded-lg bg-urgent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('Delete the family forever')}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPassword('');
                setCode('');
                setConfirm('');
                setError(null);
              }}
              className="text-sm text-muted underline underline-offset-2 hover:text-ink"
            >
              {t('Cancel')}
            </button>
          </div>

          {error && <p className="text-sm text-urgent">{error}</p>}
        </div>
      )}
    </section>
  );
}

export function FamilyDataSection() {
  const { user } = useAuth();
  // The same shared answer the sidebar and Settings read — one request
  const { state } = useServiceState();

  // Demo sandboxes are throwaways: nothing worth archiving, nothing to
  // delete — the sandbox buries itself. Both cards disappear entirely.
  if (user?.role !== 'admin' || !state || state.demo) return null;

  return (
    <>
      {state.hosted && <AddressCard />}
      <ExportCard />
      {state.hosted && <DangerZone />}
    </>
  );
}

import { t } from '../lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inlineDanger, useDialogs } from '../components/Dialog';
import { Empty, Page } from '../components/Page';
import { reportFailure } from '../lib/failures';
import { onEnter } from '../lib/keys';
import { formatDate } from '../lib/format';
import { today } from '../lib/tasks';

/*
  Family member profiles (#68): the things a household knows about each
  other. The list page doubles as the emergency screen — allergies show
  on the cards themselves, because "findable in a hurry by whoever is
  cooking" must not require knowing whose profile to open.
*/

export type FamilyRole =
  | 'mother'
  | 'father'
  | 'daughter'
  | 'son'
  | 'grandmother'
  | 'grandfather';

export const FAMILY_ROLES: FamilyRole[] = [
  'mother',
  'father',
  'daughter',
  'son',
  'grandmother',
  'grandfather',
];

/** Six gendered labels — ordinary strings, no plural machinery (#68). */
export const FAMILY_ROLE_LABEL: Record<FamilyRole, string> = {
  mother: t('Mother'),
  father: t('Father'),
  daughter: t('Daughter'),
  son: t('Son'),
  grandmother: t('Grandmother'),
  grandfather: t('Grandfather'),
};

interface Member {
  id: string;
  name: string;
  color: string;
  birthday: string | null;
  family_role: FamilyRole | null;
  allergies: string[];
}

interface Entry {
  id: string;
  kind: 'preference' | 'allergy';
  label: string;
  value: string | null;
}

interface Wish {
  id: string;
  title: string;
  url: string | null;
  // Absent entirely on the owner's own view — the server strips them
  claimed?: boolean;
  claimed_by_name?: string | null;
  claimed_by_me?: boolean;
}

interface Profile extends Omit<Member, 'allergies'> {
  wishlist_shared: boolean;
  /** Present only for self/admin — the copyable guest link, reload-proof. */
  wishlist_share_path: string | null;
  entries: Entry[];
  wishes: Wish[];
}

/** Age as of today, by the local calendar — the wall-clock convention. */
function ageOf(birthday: string): number {
  const now = today();
  let age = Number(now.slice(0, 4)) - Number(birthday.slice(0, 4));
  if (now.slice(5) < birthday.slice(5)) age -= 1;
  return age;
}

function Avatar({ name, color, size = 'size-10 text-base' }: { name: string; color: string; size?: string }) {
  return (
    <span
      className={`grid ${size} shrink-0 place-items-center rounded-full font-medium text-white`}
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {name.slice(0, 1)}
    </span>
  );
}

const chip = 'rounded-full border px-3 py-1.5 text-sm transition-colors';
const chipOn = 'border-accent bg-accent-soft text-accent';
const chipOff = 'border-line text-muted hover:text-ink';
const field =
  'rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent';

// ── The screen: who we are, and one of us ───────────────────────────────

function MemberCard({ member, active }: { member: Member; active: boolean }) {
  return (
    <Link
      to={`/family/${member.id}`}
      className={`block rounded-card border bg-surface p-4 transition-colors ${
        active ? 'border-accent' : 'border-line hover:border-accent'
      }`}
    >
      <div className="flex items-center gap-3">
        <Avatar name={member.name} color={member.color} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{member.name}</p>
          {member.family_role && (
            <p className="text-xs text-muted">{FAMILY_ROLE_LABEL[member.family_role]}</p>
          )}
        </div>
      </div>
      {member.birthday && (
        <p className="mt-3 text-sm text-muted">
          🎂 {formatDate(member.birthday)} ·{' '}
          {member.birthday <= today() ? ageOf(member.birthday) : '—'}
        </p>
      )}
      {/* The emergency line: allergies are readable from the list,
          not a click away */}
      {member.allergies.length > 0 && (
        <p className="mt-2 rounded-lg border border-urgent/40 bg-urgent/10 px-2.5 py-1.5 text-xs text-ink">
          ⚠ {t('Allergies')}: {member.allergies.join(', ')}
        </p>
      )}
    </Link>
  );
}

export function Family() {
  const { userId } = useParams<{ userId: string }>();
  const [members, setMembers] = useState<Member[] | null>(null);

  const loadMembers = useCallback(
    () => api.get<Member[]>('/profiles').then(setMembers).catch(() => setMembers([])),
    [],
  );

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  /*
    Master-detail rather than two pages. The household stays on screen
    while one profile is open, so comparing two people — or checking a
    second child's allergies — is one click instead of a round trip
    through the list. A phone has room for one pane, and shows whichever
    the URL asks for.
  */
  return (
    <Page title={t('Family')} eyebrow={t('Who we are')}>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <div className={`space-y-3 ${userId ? 'hidden lg:block' : ''}`}>
          {members === null ? (
            <div className="h-40 animate-pulse rounded-card bg-surface-3" />
          ) : (
            members.map((m) => <MemberCard key={m.id} member={m} active={m.id === userId} />)
          )}
        </div>

        <div className={userId ? '' : 'hidden lg:block'}>
          {userId ? (
            // Remounting on the id resets the add-forms: a half-typed
            // allergy must not follow you to the next person
            <MemberDetail key={userId} userId={userId} onChanged={loadMembers} />
          ) : (
            <Empty>{t('Pick someone to see their profile.')}</Empty>
          )}
        </div>
      </div>
    </Page>
  );
}

// ── One profile ─────────────────────────────────────────────────────────

function MemberDetail({ userId, onChanged }: { userId: string; onChanged: () => void }) {
  const { user } = useAuth();
  const dialogs = useDialogs();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [missing, setMissing] = useState(false);

  // Inputs for the three add-forms
  const [newAllergy, setNewAllergy] = useState('');
  const [prefLabel, setPrefLabel] = useState('');
  const [prefValue, setPrefValue] = useState('');
  const [wishTitle, setWishTitle] = useState('');
  const [wishUrl, setWishUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const own = user?.id === userId;
  const canEdit = own || user?.role === 'admin';

  const load = useCallback(() => {
    return api
      .get<Profile>(`/profiles/${userId}`)
      .then(setProfile)
      .catch((e: Error) => {
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else reportFailure(e.message);
      });
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every mutation funnels through here: act, reload, or say it failed. */
  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
      // Allergies, role and birthday are printed on the list cards too
      onChanged();
    } catch (err) {
      reportFailure(err instanceof Error ? err.message : t('Could not save'));
    }
  }

  if (missing) return <Empty>{t('Member not found')}</Empty>;
  if (!profile) return <div className="h-40 animate-pulse rounded-card bg-surface-3" />;

  const allergies = profile.entries.filter((e) => e.kind === 'allergy');
  const preferences = profile.entries.filter((e) => e.kind === 'preference');

  return (
    <div className="space-y-5">
      {/* Only a phone needs the way back — on a wide screen the list
          never went anywhere */}
      <Link to="/family" className="inline-block text-sm text-muted hover:text-ink lg:hidden">
        ← {t('All of us')}
      </Link>
      {/* Header: who this is */}
      <section className="rounded-card border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={profile.name} color={profile.color} size="size-14 text-xl" />
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg font-semibold text-ink">{profile.name}</p>
            {profile.birthday && (
              <p className="text-sm text-muted">
                🎂 {formatDate(profile.birthday)} ·{' '}
                {t('{n} years old', { n: ageOf(profile.birthday) })}
              </p>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="mt-4 space-y-3">
            <div>
              <span className="mb-1.5 block text-xs text-muted">{t('Family role')}</span>
              <div className="flex flex-wrap gap-2">
                {FAMILY_ROLES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    data-chip
                    onClick={() =>
                      void run(() =>
                        api.patch(`/profiles/${userId}`, {
                          family_role: profile.family_role === r ? null : r,
                        }),
                      )
                    }
                    className={`${chip} ${profile.family_role === r ? chipOn : chipOff}`}
                  >
                    {FAMILY_ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted">
                {t('Birthday')} — {t('appears in the shared calendar with the age')}
              </span>
              <input
                type="date"
                value={profile.birthday ?? ''}
                onChange={(e) =>
                  void run(() =>
                    api.patch(`/profiles/${userId}`, { birthday: e.target.value || null }),
                  )
                }
                className={field}
              />
            </label>
          </div>
        )}
        {!canEdit && profile.family_role && (
          <p className="mt-3 text-sm text-muted">{FAMILY_ROLE_LABEL[profile.family_role]}</p>
        )}
      </section>

      {/* Allergies — first and loud: the block a babysitter must find */}
      <section className="rounded-card border border-urgent/40 bg-surface p-5">
        <h2 className="eyebrow mb-3">{t('Allergies and medical notes')}</h2>
        {allergies.length === 0 && (
          <p className="text-sm text-muted">{t('None known — good.')}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {allergies.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-2 rounded-full border border-urgent/40 bg-urgent/10 px-3 py-1.5 text-sm text-ink"
            >
              {a.label}
              {canEdit && (
                <button
                  type="button"
                  onClick={() =>
                    void run(() => api.delete(`/profiles/${userId}/entries/${a.id}`))
                  }
                  aria-label={t('Remove {name}', { name: a.label })}
                  className="text-muted hover:text-urgent"
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
        {canEdit && (
          <div className="mt-3 flex gap-2">
            <input
              value={newAllergy}
              onChange={(e) => setNewAllergy(e.target.value)}
              onKeyDown={onEnter(() => {
                if (!newAllergy.trim()) return;
                void run(() =>
                  api.post(`/profiles/${userId}/entries`, {
                    kind: 'allergy',
                    label: newAllergy.trim(),
                  }),
                ).then(() => setNewAllergy(''));
              })}
              placeholder={t('e.g. nuts, penicillin')}
              className={`${field} w-56`}
            />
          </div>
        )}
      </section>

      {/* Preferences — label/value pairs, scannable in a shop */}
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="eyebrow mb-3">{t('Preferences')}</h2>
        {preferences.length === 0 && (
          <p className="text-sm text-muted">
            {t('Sizes, favourite tea, the things you need in a shop and never remember.')}
          </p>
        )}
        <ul className="space-y-1.5">
          {preferences.map((p) => (
            <li key={p.id} className="group flex items-baseline gap-2 text-sm">
              <span className="text-muted">{p.label}</span>
              <span className="flex-1 border-b border-dotted border-line" aria-hidden />
              <span className="text-ink">{p.value}</span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() =>
                    void run(() => api.delete(`/profiles/${userId}/entries/${p.id}`))
                  }
                  aria-label={t('Remove {name}', { name: p.label })}
                  className="text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-urgent"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={prefLabel}
              onChange={(e) => setPrefLabel(e.target.value)}
              placeholder={t('Shoes')}
              className={`${field} w-36`}
            />
            <input
              value={prefValue}
              onChange={(e) => setPrefValue(e.target.value)}
              onKeyDown={onEnter(() => {
                if (!prefLabel.trim()) return;
                void run(() =>
                  api.post(`/profiles/${userId}/entries`, {
                    kind: 'preference',
                    label: prefLabel.trim(),
                    value: prefValue.trim() || null,
                  }),
                ).then(() => {
                  setPrefLabel('');
                  setPrefValue('');
                });
              })}
              placeholder="38"
              className={`${field} w-36`}
            />
            <span className="self-center text-xs text-muted">{t('Enter adds')}</span>
          </div>
        )}
      </section>

      {/* Wishlist */}
      <section className="rounded-card border border-line bg-surface p-5">
        <h2 className="eyebrow mb-3">{t('Wishlist')}</h2>
        {profile.wishes.length === 0 && (
          <p className="text-sm text-muted">
            {own ? t('Wish for something — the family is watching.') : t('Nothing wished for yet.')}
          </p>
        )}
        <ul className="space-y-2">
          {profile.wishes.map((w) => (
            <li key={w.id} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1">
                {w.url ? (
                  <a
                    href={w.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    {w.title}
                  </a>
                ) : (
                  <span className="text-ink">{w.title}</span>
                )}
              </span>
              {/* The claim column exists only on someone else's list —
                  the server never sends claim fields to the owner */}
              {!own &&
                (w.claimed ? (
                  w.claimed_by_me ? (
                    <button
                      type="button"
                      onClick={() => void run(() => api.delete(`/wishes/${w.id}/claim`))}
                      className="shrink-0 text-xs text-accent underline underline-offset-2"
                    >
                      {t('Reserved by you — release')}
                    </button>
                  ) : (
                    <span className="shrink-0 text-xs text-muted">
                      {t('Reserved: {name}', { name: w.claimed_by_name ?? '' })}
                    </span>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => void run(() => api.post(`/wishes/${w.id}/claim`, {}))}
                    className={`${chip} ${chipOff} shrink-0 text-xs`}
                  >
                    {t('Reserve')}
                  </button>
                ))}
              {canEdit && (
                <button
                  type="button"
                  onClick={() =>
                    void dialogs
                      .confirm({
                        title: t('Delete wish'),
                        message: w.title,
                        confirmLabel: t('Delete'),
                        danger: true,
                      })
                      .then((ok) => {
                        if (ok) void run(() => api.delete(`/profiles/${userId}/wishes/${w.id}`));
                      })
                  }
                  aria-label={t('Remove {name}', { name: w.title })}
                  className="shrink-0 text-muted hover:text-urgent"
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>

        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={wishTitle}
              onChange={(e) => setWishTitle(e.target.value)}
              placeholder={t('A red bicycle')}
              className={`${field} w-56`}
            />
            <input
              value={wishUrl}
              onChange={(e) => setWishUrl(e.target.value)}
              onKeyDown={onEnter(() => {
                if (!wishTitle.trim()) return;
                void run(() =>
                  api.post(`/profiles/${userId}/wishes`, {
                    title: wishTitle.trim(),
                    url: wishUrl.trim() || null,
                  }),
                ).then(() => {
                  setWishTitle('');
                  setWishUrl('');
                });
              })}
              placeholder={t('link (optional)')}
              className={`${field} w-56`}
            />
          </div>
        )}

        {/* The public link — the only thing here a guest ever sees */}
        {canEdit && (
          <div className="mt-4 border-t border-line pt-3 text-sm">
            {profile.wishlist_share_path ? (
              /* The link stays copyable for as long as it lives — it comes
                 with the profile, so a reload changes nothing (the token is
                 stored plaintext for exactly this, see migration 021) */
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-surface-2 px-2 py-1 text-xs break-all">
                  {`${window.location.origin}${profile.wishlist_share_path}`}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(`${window.location.origin}${profile.wishlist_share_path}`)
                      .then(() => setCopied(true));
                  }}
                  className={`${chip} ${chipOff} text-xs`}
                >
                  {copied ? t('Copied') : t('Copy')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void run(() => api.delete(`/profiles/${userId}/wishlist-share`))
                  }
                  className={`${inlineDanger} text-xs`}
                >
                  {t('Revoke')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCopied(false);
                  void run(() => api.post(`/profiles/${userId}/wishlist-share`, {}));
                }}
                className={`${chip} ${chipOff} text-xs`}
              >
                {t('Share with guests — a link without an account')}
              </button>
            )}
            <p className="mt-2 text-xs text-muted">
              {t('Guests see the wishes and can reserve; reservations are hidden from {name}.', {
                name: profile.name,
              })}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

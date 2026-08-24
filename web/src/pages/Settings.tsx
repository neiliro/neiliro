import { lang, setLang, t } from '../lib/i18n';
import { BUILD_SHA, ISSUES_URL, REPO_URL, VERSION } from '../lib/build';
import { formatStamp, setWeekStart, weekStart } from '../lib/format';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDialogs } from '../components/Dialog';
import { plural } from '../lib/format';
import { Page } from '../components/Page';
import { onEnter } from '../lib/keys';
import { PALETTE, addToPalette, loadCustomPalette, removeFromPalette } from '../lib/palette';
import { COMMON_CURRENCIES, formatAmountInput, parseAmount } from '../lib/money';
import { PeopleSection } from '../components/PeopleSection';
import { MailSection } from '../components/MailSection';
import { TotpSection } from '../components/TotpSection';
import { FamilyDataSection } from '../components/FamilyDataSection';

/**
 * Own name and avatar colour, self-service (#64). Colour is the whole
 * visual identity here — the avatar is a letter plus a colour — and
 * asking the administrator to change your own was an odd asymmetry when
 * password, Google, two-factor and devices are all self-service. The
 * server allows exactly this pair on one's own account; role and the
 * disable switch stay admin-only.
 */
function ProfileSection() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [color, setColor] = useState(user?.color ?? PALETTE[0]!);
  const [status, setStatus] = useState<string | null>(null);

  if (!user) return null;
  const dirty = name.trim() !== user.name || color.toLowerCase() !== user.color.toLowerCase();

  async function save() {
    if (!user || !name.trim()) return;
    setStatus(null);
    try {
      await api.patch(`/users/${user.id}`, { name: name.trim(), color });
      await refresh();
      setStatus(t('Saved'));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('Could not save'));
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-3">{t('Profile')}</h2>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">{t('Name')}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onEnter(() => void save())}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
      </label>

      <div className="mt-3">
        <span className="mb-1.5 block text-sm font-medium text-ink">{t('Colour')}</span>
        <div className="flex flex-wrap items-center gap-2">
          {/* The current colour joins the row even when it is not in the
              stock palette (invited members got palette colours, but the
              admin's default and custom picks may not be there) */}
          {[...new Set([user.color, ...PALETTE])].map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t('Colour {color}', { color: c })}
              onClick={() => setColor(c)}
              style={{ backgroundColor: c }}
              className={`size-7 rounded-full transition-transform ${
                color.toLowerCase() === c.toLowerCase()
                  ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                  : 'hover:scale-110'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || !name.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('Save')}
        </button>
        {status && <span className="text-sm text-muted">{status}</span>}
      </div>
    </section>
  );
}

/**
 * The hub's custom colors on top of the stock palette. The list also grows
 * from the color pickers in entity dialogs; this is where it gets pruned.
 */
function PaletteSection() {
  const [custom, setCustom] = useState<string[] | null>(null);
  // The native color input fires change per drag tick — debounce the save
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void loadCustomPalette()
      .then(setCustom)
      .catch(() => setCustom([]));
  }, []);

  function add(color: string) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void addToPalette(color).then(setCustom);
    }, 800);
  }

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-3">{t('Palette')}</h2>
      <p className="mb-3 text-xs text-muted">
        {t('Your own colors for projects, accounts, categories and calendars — on top of the stock ones. Grows from here and from the "+" button right in the color picker.')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {PALETTE.map((color) => (
          <span
            key={color}
            className="size-7 rounded-full opacity-60"
            style={{ backgroundColor: color }}
            title={t('Stock color')}
          />
        ))}
        {(custom ?? []).map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => void removeFromPalette(color).then(setCustom)}
            style={{ backgroundColor: color }}
            title={t('Remove {color}', { color })}
            aria-label={t('Remove {color}', { color })}
            className="group relative size-7 rounded-full"
          >
            <span className="absolute inset-0 grid place-items-center rounded-full bg-black/40 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
              ×
            </span>
          </button>
        ))}
        <label
          className="grid size-7 cursor-pointer place-items-center rounded-full border border-dashed border-line text-sm text-muted transition-colors hover:border-accent hover:text-accent"
          title={t('Add color')}
        >
          +
          <input
            type="color"
            onChange={(e) => add(e.target.value)}
            className="sr-only"
            aria-label={t('Add color')}
          />
        </label>
      </div>
    </section>
  );
}

interface SessionInfo {
  id: string;
  created_at: string;
  last_seen_at: string | null;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

/**
 * A recognisable device name out of a user agent — a handful of
 * substring checks, deliberately not a parsing library: "Chrome ·
 * iPhone" answers "which device is this" well enough.
 */
function deviceLabel(ua: string | null): string {
  if (!ua) return t('Unknown device');
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua) || /CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : t('Browser');
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
  return os ? `${browser} · ${os}` : browser;
}

/** Messages after returning from Google during linking — the code is in ?google= */
const LINK_MESSAGES: Record<string, string> = {
  linked: t('Google linked. You can now use the button on the sign-in screen.'),
  taken: t('This Google account is already linked to another account.'),
  error: t('Could not link Google. Please try again.'),
};

/**
 * Sign-in methods. The rules are server-side, this is only their mirror:
 * the password can be disabled only with Google linked and never for the
 * admin; Google cannot be unlinked while the password is disabled.
 */
function SignInSection() {
  const { user, refresh } = useAuth();
  const dialogs = useDialogs();
  const [status, setStatus] = useState<string | null>(null);
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [showSessions, setShowSessions] = useState(false);
  const sessionCount = sessions?.length ?? null;

  const loadSessions = () =>
    api
      .get<{ sessions: SessionInfo[] }>('/auth/sessions')
      .then((s) => setSessions(s.sessions))
      .catch(() => {});

  useEffect(() => {
    void api
      .get<{ google: boolean }>('/auth/state')
      .then((s) => setGoogleAvailable(s.google))
      .catch(() => {});
    void loadSessions();
    const code = new URLSearchParams(window.location.search).get('google');
    if (code && LINK_MESSAGES[code]) {
      setStatus(LINK_MESSAGES[code]);
      window.history.replaceState(null, '', '/settings');
    }
  }, []);

  if (!user) return null;
  const linked = Boolean(user.google_linked);
  const passwordOff = Boolean(user.password_login_disabled);

  async function run(action: () => Promise<unknown>) {
    setStatus(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('Could not save'));
    }
  }

  const rowButton =
    'rounded-lg border border-line px-3 py-1.5 text-sm text-ink transition-colors hover:bg-surface-2';

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-4">{t('Signing in')}</h2>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">Google</p>
          <p className="text-xs text-muted">
            {linked ? t('Linked') : googleAvailable ? t('Not linked') : t('Not configured on the server')}
          </p>
        </div>
        {googleAvailable && !linked && (
          <button
            type="button"
            className={rowButton}
            onClick={() => {
              window.location.href = '/api/auth/google/link';
            }}
          >
            {t('Link')}
          </button>
        )}
        {linked && (
          <button
            type="button"
            className={rowButton}
            disabled={passwordOff}
            title={passwordOff ? t('Enable password sign-in first') : undefined}
            onClick={() => void run(() => api.post('/auth/google/unlink', {}))}
          >
            {t('Unlink')}
          </button>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
        <div>
          <p className="text-sm font-medium text-ink">{t('Password sign-in')}</p>
          <p className="text-xs text-muted">
            {user.role === 'admin'
              ? t('Cannot be disabled for the administrator: it is the emergency entrance')
              : passwordOff
                ? t('Disabled — sign-in via Google only')
                : linked
                  ? t('Enabled. You may disable it: Google is more secure')
                  : t('Enabled. Can be disabled once Google is linked')}
          </p>
        </div>
        {user.role !== 'admin' && (passwordOff || linked) && (
          <button
            type="button"
            className={rowButton}
            onClick={() =>
              void run(async () => {
                if (!passwordOff) {
                  const sure = await dialogs.confirm({
                    title: t('Disable password sign-in?'),
                    message: t('You will only be able to sign in with Google. If the Google account becomes unavailable, the administrator can restore access by resetting your password.'),
                    confirmLabel: t('Disable'),
                  });
                  if (!sure) return;
                }
                await api.post('/auth/password-login', { enabled: passwordOff });
              })
            }
          >
            {passwordOff ? t('Enable') : t('Disable')}
          </button>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
        <div>
          <p className="text-sm font-medium text-ink">{t('Devices')}</p>
          <p className="text-xs text-muted">
            {sessionCount === null ? (
              '…'
            ) : (
              <>
                {sessionCount} {plural(sessionCount, 'active session', 'active sessions')}
                {' · '}
                <button
                  type="button"
                  onClick={() => setShowSessions((v) => !v)}
                  className="underline underline-offset-2 hover:text-ink"
                >
                  {showSessions ? t('Hide') : t('Show')}
                </button>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          className={rowButton}
          disabled={sessionCount !== null && sessionCount <= 1}
          title={
            sessionCount !== null && sessionCount <= 1
              ? t('This is the only session')
              : undefined
          }
          onClick={() =>
            void run(async () => {
              const sure = await dialogs.confirm({
                title: t('Sign out on other devices?'),
                message: t('Every device except this one will be signed out. Useful when a phone is lost — the device also clears its offline copy the next time it comes online.'),
                confirmLabel: t('Sign out everywhere else'),
              });
              if (!sure) return;
              const res = await api.post<{ removed: number }>('/auth/sessions/revoke-others', {});
              await loadSessions();
              setStatus(`${t('Done.')} ${res.removed} ${plural(res.removed, 'session closed', 'sessions closed')}`);
            })
          }
        >
          {t('Sign out everywhere else')}
        </button>
      </div>

      {showSessions && sessions && (
        <ul className="mt-3 overflow-hidden rounded-lg border border-line">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-0"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">
                  {deviceLabel(s.user_agent)}
                  {s.current && (
                    <span className="ml-2 rounded-full border border-accent/40 bg-accent-soft px-1.5 font-mono text-[0.625rem] text-accent uppercase">
                      {t('this device')}
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-xs text-muted">
                  {s.ip ?? '—'} · {t('signed in {when}', { when: formatStamp(s.created_at) })}
                  {s.last_seen_at
                    ? ` · ${t('seen {when}', { when: formatStamp(s.last_seen_at) })}`
                    : ` · ${t('idle')}`}
                </p>
              </div>
              {!s.current && (
                <button
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await api.delete(`/auth/sessions/${s.id}`);
                      await loadSessions();
                    })
                  }
                  className="shrink-0 text-xs text-muted underline underline-offset-2 hover:text-urgent"
                >
                  {t('Revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {status && <p className="mt-3 text-sm text-muted">{status}</p>}
    </section>
  );
}

const FIELDS: { key: string; label: string; hint: string; type: string }[] = [
  { key: 'goal.title', label: t('Goal name'), hint: t('A move, a trip, a new bike — the widget title'), type: 'text' },
  { key: 'goal.date', label: t('Target date'), hint: t('The countdown counts down to it'), type: 'date' },
  { key: 'goal.saved_label', label: t('Savings caption'), hint: '', type: 'text' },
];

const CURRENCY_KEY = 'money.default_currency';
const GOAL_TARGET_KEY = 'goal.target';
const GOAL_CURRENCY_KEY = 'goal.currency';

export function Settings() {
  const { user } = useAuth();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ used: number; files: number; budget: number } | null>(
    null,
  );
  /*
    The goal's target is stored in minor units like every other amount,
    but it is typed in whole ones. Kept beside `values` rather than in
    it: the field holds what was typed until save parses it.
  */
  const [goalTarget, setGoalTarget] = useState('');

  useEffect(() => {
    void api.get<Record<string, string>>('/settings').then((loaded) => {
      setValues(loaded);
      setGoalTarget(formatAmountInput(Number(loaded[GOAL_TARGET_KEY] ?? 0) || 0));
    });
    void api
      .get<{ used: number; files: number; budget: number }>('/attachments/usage')
      .then(setUsage);
  }, []);

  async function save() {
    if (!values) return;
    setStatus(null);
    const target = goalTarget.trim() === '' ? 0 : parseAmount(goalTarget);
    if (target === null) {
      setStatus(t('Enter an amount, e.g. 4500'));
      return;
    }
    // A hand-typed "eur " must still match account currencies
    const payload = {
      ...values,
      ...(CURRENCY_KEY in values
        ? { [CURRENCY_KEY]: (values[CURRENCY_KEY] ?? '').trim().toUpperCase() }
        : {}),
      [GOAL_TARGET_KEY]: String(target),
      [GOAL_CURRENCY_KEY]: (values[GOAL_CURRENCY_KEY] ?? '').trim().toUpperCase(),
    };
    try {
      await api.patch('/settings', payload);
      setValues(payload);
      setGoalTarget(formatAmountInput(target));
      setStatus(t('Saved'));
    } catch {
      setStatus(t('Could not save'));
    }
  }

  if (!values) {
    return (
      <Page title={t('Settings')}>
        <div className="h-40 animate-pulse rounded-card bg-surface-3" />
      </Page>
    );
  }

  return (
    <Page title={t('Settings')} eyebrow={t('Board and widgets')}>
      {/* CSS columns instead of a grid: the cards vary in height, and a
          grid left ragged holes per row. The count follows the screen —
          one on phones, two on laptops, three and four on the monitors
          the 3xl/4xl breakpoints exist for; cards reflow on their own.
          Width caps keep each column near the readable max-w-md, and
          mx-auto centers the capped block like every other page. */}
      <div className="mx-auto max-w-md columns-1 gap-5 lg:max-w-4xl lg:columns-2 3xl:max-w-[86rem] 3xl:columns-3 4xl:max-w-[114rem] 4xl:columns-4">
      <div className="mb-5 break-inside-avoid space-y-5 rounded-card border border-line bg-surface p-5">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">{f.label}</span>
            <input
              type={f.type}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              onKeyDown={onEnter(() => void save())}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
            {f.hint && <span className="mt-1 block text-xs text-muted">{f.hint}</span>}
          </label>
        ))}

        {/* The goal carries its own currency: nothing here is ever
            converted, so an amount that borrowed the default currency
            would silently change meaning when that default changes. */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Target amount')}</span>
          <div className="flex items-center gap-2">
            <input
              inputMode="decimal"
              value={goalTarget}
              onChange={(e) => setGoalTarget(e.target.value)}
              onKeyDown={onEnter(() => void save())}
              aria-label={t('Target amount')}
              className="w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm tabular-nums text-ink outline-none focus:border-accent"
            />
            <input
              value={values[GOAL_CURRENCY_KEY] ?? ''}
              placeholder={(values[CURRENCY_KEY] ?? '').trim().toUpperCase() || 'EUR'}
              maxLength={3}
              onChange={(e) =>
                setValues({ ...values, [GOAL_CURRENCY_KEY]: e.target.value.toUpperCase() })
              }
              onKeyDown={onEnter(() => void save())}
              aria-label={t('Goal currency')}
              className="w-20 shrink-0 rounded-lg border border-line bg-surface-2 px-3 py-2 text-center font-mono text-sm text-ink uppercase outline-none focus:border-accent"
            />
          </div>
          <span className="mt-1 block text-xs text-muted">
            {t('Zero — the goal is only a countdown')}
          </span>
        </div>

        {/* The same chip picker as the account dialog: two different
            inputs for one concept invited typos ("EUr", a Cyrillic Е) */}
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Default currency')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {COMMON_CURRENCIES.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => setValues({ ...values, [CURRENCY_KEY]: code })}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  (values[CURRENCY_KEY] ?? '').trim().toUpperCase() === code
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line text-muted hover:text-ink'
                }`}
              >
                {code}
              </button>
            ))}
            <input
              value={
                COMMON_CURRENCIES.includes((values[CURRENCY_KEY] ?? '').trim().toUpperCase())
                  ? ''
                  : (values[CURRENCY_KEY] ?? '')
              }
              placeholder={t('Other')}
              maxLength={3}
              onChange={(e) =>
                setValues({ ...values, [CURRENCY_KEY]: e.target.value.toUpperCase() })
              }
              onKeyDown={onEnter(() => void save())}
              aria-label={t('Default currency')}
              className={`w-20 rounded-full border bg-surface-2 px-3 py-1.5 text-center font-mono text-sm text-ink uppercase outline-none focus:border-accent ${
                (values[CURRENCY_KEY] ?? '').trim() !== '' &&
                !COMMON_CURRENCIES.includes((values[CURRENCY_KEY] ?? '').trim().toUpperCase())
                  ? 'border-accent'
                  : 'border-line'
              }`}
            />
          </div>
          <span className="mt-1 block text-xs text-muted">
            {t('Pre-filled for new accounts and budgets. Any ISO 4217 code')}
          </span>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => void save()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            {t('Save')}
          </button>
          {status && <span className="text-sm text-muted">{status}</span>}
        </div>
      </div>

      <section className="mb-5 break-inside-avoid rounded-card border border-line bg-surface p-5">
        {/* The English word is kept alongside the translation so the setting
            is findable in a language you do not read — but only when the two
            actually differ, or English shows "Language / Language". */}
        <h2 className="eyebrow mb-4">
          {t('Language')}
          {t('Language') !== 'Language' && ' / Language'}
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => lang !== 'en' && setLang('en')}
            className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
              lang === 'en' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            English
          </button>
          <button
            type="button"
            onClick={() => lang !== 'ru' && setLang('ru')}
            className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
              lang === 'ru' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            Русский
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          {t('A per-device setting: a phone and the shared kiosk can speak different languages.')}
        </p>

        <h2 className="eyebrow mt-6 mb-4">{t('Week starts on')}</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => weekStart !== 'mon' && setWeekStart('mon')}
            className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
              weekStart === 'mon' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {t('Monday')}
          </button>
          <button
            type="button"
            onClick={() => weekStart !== 'sun' && setWeekStart('sun')}
            className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
              weekStart === 'sun' ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {t('Sunday')}
          </button>
        </div>
      </section>

      <div className="mb-5 break-inside-avoid">
        <ProfileSection />
      </div>

      <div className="mb-5 break-inside-avoid">
        <PaletteSection />
      </div>

      <div className="mb-5 break-inside-avoid">
        <SignInSection />
      </div>

      <div className="mb-5 break-inside-avoid">
        <TotpSection />
      </div>

      {usage && (
        <section className="mb-5 break-inside-avoid rounded-card border border-line bg-surface p-5">
          <h2 className="eyebrow mb-3">{t('Attachments')}</h2>
          <p className="text-sm text-ink">
            {usage.files} {plural(usage.files, 'file', 'files')} ·{' '}
            {(usage.used / 1024 / 1024).toFixed(1)} {t('MB')}
          </p>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.min(100, (usage.used / usage.budget) * 100).toFixed(2)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            {t('The budget is {n} GB — once it runs out, new uploads are refused. Attachments are not part of the backup archive, so keep an eye on growth.', { n: Math.round(usage.budget / 1024 / 1024 / 1024) })}
          </p>
        </section>
      )}

      <section className="mb-5 break-inside-avoid rounded-card border border-line bg-surface p-5">
        <h2 className="eyebrow mb-4">{t('About')}</h2>
        <p className="font-mono text-sm text-ink">Neiliro v{VERSION}</p>
        {BUILD_SHA && (
          <p className="mt-1 font-mono text-xs text-muted">{t('Build {sha}', { sha: BUILD_SHA })}</p>
        )}
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-line underline-offset-2 hover:opacity-80"
          >
            {t('Source code')}
          </a>
          <a
            href={ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-line underline-offset-2 hover:opacity-80"
          >
            {t('Report a bug')}
          </a>
        </div>
      </section>

      </div>

      {/* Admin blocks stay full-width below the columns: wide lists
          inside, and user feedback asked for them here rather than in
          a dedicated navigation section */}
      {user?.role === 'admin' && (
        // Explicit mt-5: the columns block above provides no bottom
        // spacing of its own — the last card's margin is truncated at
        // the column fragment edge, and the admin block sat glued to it
        <div className="mx-auto mt-5 max-w-md space-y-5 lg:max-w-4xl 3xl:max-w-[86rem] 4xl:max-w-[114rem]">
          <MailSection />
          <PeopleSection />
          <FamilyDataSection />
        </div>
      )}
    </Page>
  );
}

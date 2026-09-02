import { lang, setLang, t } from '../lib/i18n';
import { REPO_URL } from '../lib/build';
import { useServiceState } from '../lib/service';
import { supportLink } from '../lib/support';
import { useHomeName } from '../lib/home-name';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { onEnter } from '../lib/keys';
import { browserTimezone } from '../lib/timezone';

/*
  The sign-in screen is the one page a stranger can reach, so its footer
  carries where-to-go and nothing else: no version, no build. The health
  endpoint already refuses to tell the public internet which version this
  is, and a line under the login box would have undone that.
*/
function Frame({
  title,
  note,
  children,
}: {
  title: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  const displayName = useHomeName();
  /*
    Every auth screen hangs off this frame — sign in, first run, an invite,
    both halves of a password reset. That makes its footer the one place a
    locked-out family can still reach, so the help link has to be right
    here and not only inside the app. The lookup is shared and cached
    (lib/service.ts); the answer cannot change while the tab is open.
  */
  const { state: service } = useServiceState();
  const help = supportLink(service ? service.hosted : null, window.location.hostname);

  useEffect(() => {
    if (displayName) document.title = displayName;
  }, [displayName]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-2 px-5">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          {/* The brand is a proper noun, not a UI string: the same word in
              both languages, so it never goes through t(). A family-chosen
              name wins verbatim over the default. (#136) */}
          <p className="font-display text-2xl font-bold tracking-tight text-ink">{displayName ?? 'Neiliro'}</p>
        </div>
        <div className="rounded-card border border-line bg-surface p-6">
          <h1 className="eyebrow mb-5">{title}</h1>
          {children}
        </div>
        <div className="mt-4 space-y-2 text-center text-xs text-muted">
          {note}
          <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <button
              type="button"
              onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
              className="underline decoration-line underline-offset-2 hover:text-ink"
            >
              {lang === 'ru' ? 'English' : 'Русский'}
            </button>
            <span aria-hidden>·</span>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-line underline-offset-2 hover:text-ink"
            >
              {t('Source code')}
            </a>
            {/* Absent, not guessed, until the answer says which door this is */}
            {help && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={help.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-line underline-offset-2 hover:text-ink"
                >
                  {help.label === 'Support' ? t('Support') : t('Report a bug')}
                </a>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent';
const buttonClass =
  'w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50';

/** Messages after returning from Google — the code arrives in ?google= */
const GOOGLE_MESSAGES: Record<string, string> = {
  not_linked:
    t('This Google account is not linked to any hub account. Sign in with a password and link it in Settings.'),
  error: t('Could not sign in with Google. Try again or sign in with a password.'),
};

export function Login() {
  const { login, loginMfa, loginDemo } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ticket means the password passed and a TOTP code is owed
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  /*
    Which doors exist is a property of the process, and the frame around
    this form asks the same question for its help link — so both read the
    one shared answer rather than each fetching it (lib/service.ts).
  */
  const { state: service, settled } = useServiceState();
  const googleAvailable = service?.google ?? false;
  const resetAvailable = Boolean(service?.password_reset);
  const demo = Boolean(service?.demo);
  /*
    null — still finding out; false — empty DB, show the first-run setup.
    A server that refused to answer is deliberately read as initialized:
    offering to create an admin because a request failed would hand the
    family's own hub to whoever reloads at the wrong moment.
  */
  const initialized = service ? service.initialized : settled ? true : null;

  useEffect(() => {
    // The outcome of a Google sign-in arrives as a redirect with a code in the URL
    const code = new URLSearchParams(window.location.search).get('google');
    if (code && GOOGLE_MESSAGES[code]) {
      setError(GOOGLE_MESSAGES[code]);
      window.history.replaceState(null, '', '/');
    }
  }, []);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ticket = await login(email, password);
      if (ticket) setMfaToken(ticket);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not sign in'));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e?: FormEvent) {
    e?.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await loginMfa(mfaToken, mfaCode.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not sign in'));
      // An expired ticket sends the person back to the password step
      if (err instanceof Error && /start over/i.test(err.message)) {
        setMfaToken(null);
        setMfaCode('');
      }
    } finally {
      setBusy(false);
    }
  }

  // Arrived via an invite link — registration form instead of login
  if (window.location.pathname === '/join') {
    return <Join />;
  }
  // Reset flows: asking for a link, and arriving with one. Both are
  // hosted-only server-side; a self-hosted hub never advertises them.
  if (window.location.pathname === '/forgot') {
    return <ForgotPassword />;
  }
  if (window.location.pathname === '/reset') {
    return <ResetPassword />;
  }

  async function enterDemo() {
    setBusy(true);
    setError(null);
    try {
      await loginDemo();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not sign in'));
      setBusy(false);
    }
  }

  if (initialized === null) return null;
  if (!initialized) return <Setup />;

  // Demo: no password, the server hands everyone a personal sandbox at the press of a button
  if (demo) {
    return (
      <Frame
      title={t('Demo')}
      note={
        <p>
          {t('Run your own: one Docker container, the data stays at home.')}{' '}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-line underline-offset-2 hover:opacity-80"
          >
            {t('Get it on GitHub')}
          </a>
        </p>
      }
    >
        <p className="mb-5 text-sm text-muted">
          {t('This is a demo with sample data: you get your own private copy, so touch anything you like. After a couple idle hours it vanishes without a trace.')}
        </p>
        {error && <p className="mb-4 text-sm text-urgent">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void enterDemo()} className={buttonClass}>
          {busy ? t('Opening') : t('Try the demo')}
        </button>
      </Frame>
    );
  }

  return (
    mfaToken ? (
    <Frame title={t('Enter the code')}>
      <form onSubmit={submitMfa} className="space-y-4">
        <p className="text-sm text-muted">
          {t('The six-digit code from your authenticator app.')}
        </p>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={mfaCode}
          onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-center font-mono text-2xl tracking-[0.4em] text-ink outline-none focus:border-accent"
        />
        {error && <p className="text-sm text-urgent">{error}</p>}
        <button
          type="submit"
          disabled={busy || mfaCode.length !== 6}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('Confirm')}
        </button>
        <button
          type="button"
          onClick={() => {
            setMfaToken(null);
            setMfaCode('');
            setError(null);
          }}
          className="w-full text-center text-sm text-muted hover:text-ink"
        >
          {t('Back')}
        </button>
      </form>
    </Frame>
    ) : (
    <Frame title={t('Sign in')}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Login')}</span>
          <input
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={onEnter(() => void submit())}
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={onEnter(() => void submit())}
            className={inputClass}
          />
        </label>

        {error && <p className="text-sm text-urgent">{error}</p>}

        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? t('Checking') : t('Sign in')}
        </button>

        {resetAvailable && (
          <a href="/forgot" className="block text-center text-sm text-muted underline hover:text-ink">
            {t('Forgot your password?')}
          </a>
        )}

        {googleAvailable && (
          <>
            <div className="flex items-center gap-3 pt-1">
              <div className="h-px flex-1 bg-line" />
              <span className="text-xs text-muted">{t('or')}</span>
              <div className="h-px flex-1 bg-line" />
            </div>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/api/auth/google/start';
              }}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-3"
            >
              <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
                <path
                  fill="#4285F4"
                  d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.96-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.14-4.06 1.14-3.12 0-5.77-2.1-6.71-4.94H1.29v3.1A12 12 0 0 0 12 24Z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.29a12 12 0 0 0 0 10.78l4-3.1Z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.77c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.98 11.98 0 0 0 1.3 6.61l4 3.1C6.23 6.87 8.87 4.77 12 4.77Z"
                />
              </svg>
              {t('Sign in with Google')}
            </button>
          </>
        )}
      </form>
    </Frame>
    )
  );
}

/**
 * First-run setup: the DB is empty, the first account being created is
 * the admin. Passwords are no longer printed in the server logs.
 */
function Setup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/setup', {
        name,
        email,
        password,
        // Not a question on the form: the browser knows, and a family that
        // sets up from Chicago should not have to discover later why "today"
        // was flipping in the afternoon. Changeable in Settings.
        timezone: browserTimezone(),
      });
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
      setBusy(false);
    }
  }

  return (
    <Frame title={t('First run')}>
      <p className="mb-5 text-sm text-muted">
        {t('Create the first account — it becomes the administrator: it can invite family members and reset passwords.')}
      </p>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Login (email)')}</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} autoComplete="username" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
          />
          <span className="mt-1 block text-xs text-muted">{t('At least 10 characters')}</span>
        </label>
        {error && <p className="text-sm text-urgent">{error}</p>}
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? t('Creating') : t('Create and sign in')}
        </button>
      </form>
    </Frame>
  );
}

/**
 * Ask for a reset link: /forgot
 *
 * The answer is deliberately the same whether or not the address has an
 * account — the server refuses to be an account oracle, and the wording
 * here must not undo that by saying "sent" only on a hit.
 */
function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/password-reset', { email: email.trim() });
    } catch {
      // Even a failure says nothing: the neutral screen follows either way
    }
    setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <Frame title={t('Password reset')}>
        <p className="text-sm text-muted">
          {t('If that address has an account here, a link is on its way. It works once, for one hour.')}
        </p>
        <a href="/" className="mt-5 block text-center text-sm text-muted underline hover:text-ink">
          {t('Back to sign in')}
        </a>
      </Frame>
    );
  }

  return (
    <Frame title={t('Password reset')}>
      <p className="mb-5 text-sm text-muted">
        {t('Enter the address you sign in with and we will send a link to set a new password.')}
      </p>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Login (email)')}</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            autoComplete="username"
            autoFocus
          />
        </label>
        <button type="submit" disabled={busy || !email.trim()} className={buttonClass}>
          {busy ? t('Sending') : t('Send the link')}
        </button>
        <a href="/" className="block text-center text-sm text-muted underline hover:text-ink">
          {t('Back to sign in')}
        </a>
      </form>
    </Frame>
  );
}

/** Set a new password from an emailed link: /reset?token=... */
function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/password-reset/confirm', { token, password });
      // Every session was closed by the reset, this one included — the
      // sign-in screen is the honest place to land
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <Frame title={t('Password reset')}>
        <p className="text-sm text-muted">
          {t('This link is not valid. Request a new one from the sign-in screen.')}
        </p>
        <a href="/" className="mt-5 block text-center text-sm text-muted underline hover:text-ink">
          {t('Back to sign in')}
        </a>
      </Frame>
    );
  }

  return (
    <Frame title={t('Password reset')}>
      <p className="mb-5 text-sm text-muted">{t('Choose a new password. Signing in elsewhere will be required again.')}</p>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('New password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
            autoFocus
          />
          <span className="mt-1.5 block text-xs text-muted">{t('At least 10 characters')}</span>
        </label>
        {error && <p className="text-sm text-urgent">{error}</p>}
        <button type="submit" disabled={busy || password.length < 10} className={buttonClass}>
          {busy ? t('Saving') : t('Save and sign in')}
        </button>
      </form>
    </Frame>
  );
}

interface InviteCheck {
  valid: true;
  role: 'admin' | 'member' | 'kid';
  /** The address the invitation was mailed to — the founder's, confirmed by construction. */
  email: string | null;
}

/**
 * Signup via an invite link: /join?token=...
 *
 * The same page serves two arrivals. A member invited by the admin fills
 * in the usual three fields. The founder of a hosted family arrives here
 * too — the service mailed them the link (#157) — and for them this *is*
 * the first-run screen: the copy says so, the login is pre-filled with the
 * address the invitation reached, and the browser's timezone rides along
 * exactly as it does on the open first run.
 */
function Join() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  // null — validating the link; then either the form or an explanation
  const [invite, setInvite] = useState<InviteCheck | false | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvite(false);
      return;
    }
    void api
      .get<InviteCheck>(`/auth/invite?token=${encodeURIComponent(token)}`)
      .then((check) => {
        setInvite(check);
        if (check.email) setEmail(check.email);
      })
      .catch(() => setInvite(false));
  }, [token]);

  const founder = invite !== null && invite !== false && invite.role === 'admin';
  const proven = invite !== null && invite !== false && invite.email !== null && email.trim().toLowerCase() === invite.email;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/join', {
        token,
        name,
        email,
        password,
        ...(founder ? { timezone: browserTimezone() } : {}),
      });
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
      setBusy(false);
    }
  }

  if (invite === null) return null;
  if (invite === false) {
    return (
      <Frame title={t('Invitation')}>
        <p className="text-sm text-muted">
          {t('This link is no longer valid: it has expired or was already used. Ask the person who runs the hub for a new one.')}
        </p>
      </Frame>
    );
  }

  return (
    <Frame title={founder ? t('First run') : t('Invitation')}>
      <p className="mb-5 text-sm text-muted">
        {founder
          ? t('Create the first account — it becomes the administrator: it can invite family members and reset passwords.')
          : t('You have been invited to Neiliro. Set up your account:')}
      </p>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} autoFocus />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Login (email)')}</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} autoComplete="username" />
          {invite.email && (
            <span className="mt-1 block text-xs text-muted">
              {proven
                ? t('The address the invitation came to — already confirmed for password recovery.')
                : t('A different address than the invitation came to: we will ask you to confirm it.')}
            </span>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            autoComplete="new-password"
          />
          <span className="mt-1 block text-xs text-muted">{t('At least 10 characters')}</span>
        </label>
        {error && <p className="text-sm text-urgent">{error}</p>}
        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? t('Creating') : founder ? t('Create and sign in') : t('Join')}
        </button>
      </form>
    </Frame>
  );
}

export function ChangePassword() {
  const { logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (next !== repeat) {
      setError(t('Passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not change the password'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Frame title={t('Password changed')}>
        <p className="mb-5 text-sm text-muted">
          {t('Password updated. All devices were signed out — sign in again with the new password.')}
        </p>
        <button type="button" onClick={() => void logout()} className={buttonClass}>
          {t('Sign in again')}
        </button>
      </Frame>
    );
  }

  return (
    <Frame title={t('Change password')}>
      <p className="mb-5 text-sm text-muted">
        {t('The issued password was shown once. Set your own before continuing.')}
      </p>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Issued password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            onKeyDown={onEnter(() => void submit())}
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('New password')}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            onKeyDown={onEnter(() => void submit())}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-muted">{t('At least 10 characters')}</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">{t('Try again')}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            onKeyDown={onEnter(() => void submit())}
            className={inputClass}
          />
        </label>

        {error && <p className="text-sm text-urgent">{error}</p>}

        <button type="submit" disabled={busy} className={buttonClass}>
          {busy ? t('Saving') : t('Change password')}
        </button>
      </form>
    </Frame>
  );
}

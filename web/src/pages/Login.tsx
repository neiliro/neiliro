import { lang, setLang, t } from '../lib/i18n';
import { ISSUES_URL, REPO_URL } from '../lib/build';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { onEnter } from '../lib/keys';

/*
  The sign-in screen is the one page a stranger can reach, so its footer
  carries where-to-go and nothing else: no version, no build. The health
  endpoint already refuses to tell the public internet which version this
  is, and a line under the login box would have undone that.
*/
function Frame({
  title,
  hint,
  note,
  children,
}: {
  title: string;
  hint: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-2 px-5">
      <div className="w-full max-w-sm">
        <div className="mb-7 text-center">
          <p className="font-display text-2xl font-bold tracking-tight text-ink">{t('Home')}</p>
          <p className="mt-1.5 text-sm text-muted">{hint}</p>
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
            <span aria-hidden>·</span>
            <a
              href={ISSUES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-line underline-offset-2 hover:text-ink"
            >
              {t('Report a bug')}
            </a>
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
  const [googleAvailable, setGoogleAvailable] = useState(false);
  const [demo, setDemo] = useState(false);
  // null — still finding out; false — empty DB, show the first-run setup
  const [initialized, setInitialized] = useState<boolean | null>(null);

  useEffect(() => {
    void api
      .get<{ initialized: boolean; google: boolean; demo?: boolean }>('/auth/state')
      .then((s) => {
        setGoogleAvailable(s.google);
        setInitialized(s.initialized);
        setDemo(Boolean(s.demo));
      })
      .catch(() => setInitialized(true));
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
      hint="Neiliro"
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
    <Frame title={t('Enter the code')} hint="Neiliro">
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
    <Frame title={t('Sign in')} hint="Neiliro">
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
      await api.post('/auth/setup', { name, email, password });
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
      setBusy(false);
    }
  }

  return (
    <Frame title={t('First run')} hint="Neiliro">
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

/** Signup via an invite link: /join?token=... */
function Join() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  // null — validating the link; then either the form or an explanation
  const [valid, setValid] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setValid(false);
      return;
    }
    void api
      .get(`/auth/invite?token=${encodeURIComponent(token)}`)
      .then(() => setValid(true))
      .catch(() => setValid(false));
  }, [token]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/join', { token, name, email, password });
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
      setBusy(false);
    }
  }

  if (valid === null) return null;
  if (!valid) {
    return (
      <Frame title={t('Invitation')} hint="Neiliro">
        <p className="text-sm text-muted">
          {t('This link is no longer valid: it has expired or was already used. Ask the person who runs the hub for a new one.')}
        </p>
      </Frame>
    );
  }

  return (
    <Frame title={t('Invitation')} hint="Neiliro">
      <p className="mb-5 text-sm text-muted">{t('You have been invited to Neiliro. Set up your account:')}</p>
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
          {busy ? t('Creating') : t('Join')}
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
      <Frame title={t('Password changed')} hint="Neiliro">
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
    <Frame title={t('Change password')} hint="Neiliro">
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

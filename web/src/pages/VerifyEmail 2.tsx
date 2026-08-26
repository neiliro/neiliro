import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

/*
  Landing page for the confirmation link: /verify-email?token=...

  Deliberately outside the auth gate, next to the public wishlist. The link
  is opened wherever the mail was read — often another browser, often on a
  phone — and requiring a session first would send people to a sign-in
  screen for no reason. The token is the authorization.
*/
export function VerifyEmail() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState('failed');
      return;
    }
    void api
      .post('/auth/email-verify', { token })
      .then(() => setState('done'))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : null);
        setState('failed');
      });
  }, [token]);

  return (
    <div className="grid min-h-dvh place-items-center bg-surface-2 p-6">
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 text-center">
        <p className="eyebrow mb-3">{t('Address confirmation')}</p>
        {state === 'working' && <p className="text-sm text-muted">{t('Confirming…')}</p>}
        {state === 'done' && (
          <>
            <p className="text-sm text-ink">
              {t('Address confirmed. If you ever forget your password, you can now reset it by email.')}
            </p>
            <a
              href="/"
              className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {t('Open Neiliro')}
            </a>
          </>
        )}
        {state === 'failed' && (
          <>
            <p className="text-sm text-ink">{error ?? t('This link is not valid')}</p>
            <p className="mt-2 text-sm text-muted">
              {t('Sign in and use the reminder at the top of the page to send a fresh link.')}
            </p>
            <a href="/" className="mt-5 inline-block text-sm text-muted underline hover:text-ink">
              {t('Open Neiliro')}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

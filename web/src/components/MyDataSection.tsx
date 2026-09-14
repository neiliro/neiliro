import { useState } from 'react';
import { t } from '../lib/i18n';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deriveWith, prelogin } from '../lib/credentials';
import { collectMyData, downloadJson } from '../lib/my-data';
import { today } from '../lib/tasks';

const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent';

/*
  The two rights a person holds against the hub personally, not through
  their family (GDPR art. 15/20 and 17): a readable copy of what they can
  see, and the door out.

  The copy is assembled in the browser (lib/my-data.ts) so it holds words,
  not envelopes. Leaving is proven with the password and the second
  factor, like deleting the family — a stolen session must not be enough.
  What leaving removes and what it leaves the family is the server's rule
  (lib/erase-member.ts) and is said here in one paragraph; the last
  administrator is refused by the server and told to delete the family
  or hand the role on first.
*/
export function MyDataSection() {
  const { user, logout } = useAuth();
  const [collecting, setCollecting] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const needsCode = Boolean(user.totp_enabled);
  const ready = password.length > 0 && (!needsCode || code.trim().length >= 6);

  async function download() {
    if (!user) return;
    setCollecting(true);
    setError(null);
    try {
      downloadJson(await collectMyData(user.id), `neiliro-my-data-${today()}.json`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setCollecting(false);
    }
  }

  async function leave() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/users/me/erase', {
        auth_key: await deriveWith(password, (await prelogin(user.email)).salt),
        code: needsCode ? code.trim() : undefined,
      });
      await logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
      setBusy(false);
    }
  }

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-3">{t('My data')}</h2>
      <p className="mb-3 text-sm text-muted">
        {t('A readable copy of everything this account can see, as one JSON file: your account, your notes, tasks, events, money and lists, opened on this device. Files are not included.')}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={collecting}
          onClick={() => void download()}
          className="rounded-lg border border-line bg-surface px-4 py-2 text-sm text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {collecting ? t('Collecting…') : t('Download my data')}
        </button>
      </div>

      <h3 className="mt-6 mb-2 text-sm font-medium text-urgent">{t('Leave the family')}</h3>
      <p className="mb-3 text-sm text-muted">
        {t('Removes your account for good: your private notes, personal calendars and personal accounts, your profile, your sessions and your key. What you added to shared spaces stays with the family without your name. There is no undo.')}
      </p>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-urgent/40 bg-urgent/10 px-4 py-2 text-sm font-medium text-urgent hover:opacity-90"
        >
          {t('Delete my account…')}
        </button>
      ) : (
        <div className="max-w-md space-y-3">
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
              <span className="mb-1.5 block text-sm font-medium text-ink">{t('Code from the authenticator app')}</span>
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                className={inputClass}
              />
            </label>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => void leave()}
              className="rounded-lg bg-urgent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {t('Delete my account forever')}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPassword('');
                setCode('');
                setError(null);
              }}
              className="text-sm text-muted underline underline-offset-2 hover:text-ink"
            >
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-urgent">{error}</p>}
    </section>
  );
}

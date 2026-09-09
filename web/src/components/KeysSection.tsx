import { useState } from 'react';
import { t } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { useKeys } from '../lib/family-key';
import { RecoveryCodeDialog, RecoveryCodePanel } from './RecoveryCode';
import { encryptExistingNotes, type EncryptProgress } from '../lib/encrypt-existing';

/*
  Settings → Family key. Every member sees where this device stands and can
  lock it; adults holding the key can mint a new recovery code. Nothing here
  reveals the key: the code is shown exactly once when made, like the first.
*/
export function KeysSection() {
  const { user } = useAuth();
  const { status, lock, newRecoveryCode, pendingHandoffs } = useKeys();
  const [entering, setEntering] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<EncryptProgress | null>(null);
  const [jobRunning, setJobRunning] = useState(false);

  async function encryptNotes() {
    setJobRunning(true);
    setError(null);
    try {
      await encryptExistingNotes(setJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    } finally {
      setJobRunning(false);
    }
  }

  const rowButton =
    'rounded-lg border border-line px-3 py-1.5 text-sm text-ink transition-colors hover:bg-surface-2 disabled:opacity-50';

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      setFresh(await newRecoveryCode());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
    } finally {
      setBusy(false);
    }
  }

  const statusLine =
    status === 'unlocked'
      ? t('This device holds the family key.')
      : status === 'locked'
        ? pendingHandoffs.length > 0
          ? t('A re-admission link from {name} is waiting — open it on this device.', {
              name: pendingHandoffs[0]!.created_by_name ?? t('a family member'),
            })
          : t('This device does not hold the family key. Ask a family member for a re-admission link, or enter the recovery code.')
        : status === 'absent'
          ? t('The family has no key yet. It is created when an adult member signs in with a password.')
          : '…';

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-4">{t('Family key')}</h2>
      <p className="text-sm text-muted">
        {t('The key that will encrypt what the family writes, so that only the family can read it. It lives in your browsers; the server holds it only wrapped under each member’s password.')}
      </p>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-sm text-ink">{statusLine}</p>
        {status === 'unlocked' && (
          <button type="button" className={rowButton} onClick={() => void lock()}>
            {t('Lock this device')}
          </button>
        )}
        {status === 'locked' && (
          <button type="button" className={rowButton} onClick={() => setEntering(true)}>
            {t('Enter recovery code')}
          </button>
        )}
      </div>

      {status === 'unlocked' && user?.role !== 'kid' && (
        <div className="mt-4 border-t border-line pt-4">
          {fresh ? (
            <RecoveryCodePanel code={fresh} onDone={() => setFresh(null)} doneLabel={t('Recorded, hide')} />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">{t('Recovery code')}</p>
                <p className="text-xs text-muted">
                  {t('Lost the paper? Make a new one — the old code stops working the moment this one is shown.')}
                </p>
              </div>
              <button type="button" className={rowButton} disabled={busy} onClick={() => void mint()}>
                {t('New recovery code')}
              </button>
            </div>
          )}
        </div>
      )}

      {status === 'unlocked' && user?.role !== 'kid' && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
          <div>
            <p className="text-sm font-medium text-ink">{t('Encrypt existing notes')}</p>
            <p className="text-xs text-muted">
              {job === null
                ? t('Notes written before the key existed are still readable on the server. This rewrites them under the key, here in your browser; each member does it once for their private notes.')
                : jobRunning
                  ? t('Encrypting… {done} of {total}', { done: job.done + job.failed, total: job.total })
                  : job.total === 0
                    ? t('Nothing left to encrypt.')
                    : job.failed === 0
                      ? t('Done — {n} encrypted.', { n: job.done })
                      : t('Done — {n} encrypted, {failed} failed. Run it again.', { n: job.done, failed: job.failed })}
            </p>
          </div>
          <button type="button" className={rowButton} disabled={jobRunning} onClick={() => void encryptNotes()}>
            {t('Encrypt')}
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-urgent">{error}</p>}
      {entering && <RecoveryCodeDialog onClose={() => setEntering(false)} />}
    </section>
  );
}

import { useState } from 'react';
import { t } from '../lib/i18n';
import { Modal, dialogField, dialogGhost, dialogPrimary } from './Dialog';
import { doorMessage, useKeys } from '../lib/family-key';

/*
  The recovery code, shown once (ADR 0001, #210).

  It is the family's last door: after a lost password *and* no other member
  to re-admit you, this code is the only thing that still opens the key.
  So it is not a toast and not a help page — a screen that waits for an
  explicit "I wrote it down", with the consequence said in plain words.
*/
export function RecoveryCodePanel({
  code,
  onDone,
  doneLabel,
}: {
  code: string;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // No clipboard here — the code is on screen to be written down anyway
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {t('This is your family’s recovery code. It opens the family key when a password no longer can — after a reset, or on a new device with nobody around to let you in.')}
      </p>
      <p className="select-all rounded-lg border border-line bg-surface-2 px-3 py-3 text-center font-mono text-lg tracking-wider text-ink">
        {code}
      </p>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => void copy()} className="text-sm text-accent underline underline-offset-2">
          {copied ? t('Copied') : t('Copy')}
        </button>
        <span className="text-xs text-muted">{t('Case and dashes do not matter when typing it back.')}</span>
      </div>
      <label className="flex items-start gap-2.5 text-sm text-ink">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--c-accent)]"
        />
        <span>
          {t('I have written it down somewhere safe. I understand that without my password and without this code, what the family encrypts is gone for good — nobody can recover it, including the people who run Neiliro.')}
        </span>
      </label>
      <button
        type="button"
        disabled={!acknowledged}
        onClick={onDone}
        className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {doneLabel ?? t('Continue')}
      </button>
    </div>
  );
}

/** The full-screen moment right after the key is created. */
export function RecoveryCodeScreen({ code, onDone }: { code: string; onDone: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-2 px-5">
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6">
        <h1 className="eyebrow mb-5">{t('Your family now has a key')}</h1>
        <p className="mb-4 text-sm text-muted">
          {t('Encryption of what the family writes starts with this key. It was created in this browser and never leaves it unprotected: the server only holds it wrapped under your password.')}
        </p>
        <RecoveryCodePanel code={code} onDone={onDone} />
      </div>
    </div>
  );
}

/** Typing the code back in — from the locked notice or from Settings. */
export function RecoveryCodeDialog({ onClose }: { onClose: () => void }) {
  const { unlockWithRecoveryCode } = useKeys();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlockWithRecoveryCode(code);
      onClose();
    } catch (err) {
      setError(t(doorMessage(err, 'Something went wrong')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('Recovery code')}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" onClick={onClose} className={dialogGhost}>
            {t('Cancel')}
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || !code.trim()} className={dialogPrimary}>
            {busy ? t('Checking') : t('Unlock')}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        {t('The code shown when the family key was created. It opens the key on this device and wraps it under your current password, so you will not need it here again.')}
      </p>
      <input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        className={`${dialogField} font-mono tracking-wider`}
      />
      {error && <p className="mt-2 text-sm text-urgent">{error}</p>}
    </Modal>
  );
}

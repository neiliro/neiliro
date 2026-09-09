import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n';
import { doorMessage, useKeys } from '../lib/family-key';
import { handoffSecretFromFragment } from '../lib/crypto';

/*
  /readmit?handoff=<id>#k=<secret> — the other end of a re-admission link
  (#210). The id is a query parameter and reaches the server; the secret is
  in the fragment and never does. Opened while signed in as the member the
  handoff was made for; the key is then held on this device and re-wrapped
  under the current password.
*/
export function Readmit() {
  const navigate = useNavigate();
  const { status, unlockWithHandoff } = useKeys();
  const [outcome, setOutcome] = useState<'working' | 'done' | 'already' | string>('working');
  // One attempt per page: opening the handoff flips status to unlocked, and
  // a second pass would read that as "already held" and overwrite the result
  const attempted = useRef(false);

  useEffect(() => {
    if (status === 'loading' || attempted.current) return;
    attempted.current = true;
    const handoffId = new URLSearchParams(window.location.search).get('handoff');
    const secret = handoffSecretFromFragment(window.location.hash);
    if (status === 'unlocked') {
      setOutcome('already');
      return;
    }
    if (!handoffId) {
      setOutcome(t('This is not a re-admission link.'));
      return;
    }
    if (!secret) {
      setOutcome(
        t('This link lost the part after the # — some messengers cut it off. Ask for a new one and paste it whole.'),
      );
      return;
    }
    unlockWithHandoff(handoffId, secret)
      .then(() => setOutcome('done'))
      .catch((err: unknown) => setOutcome(t(doorMessage(err, 'Something went wrong'))));
    // The link's parameters do not change under a mounted page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="mx-auto max-w-md p-6">
      <div className="rounded-card border border-line bg-surface p-6">
        <h1 className="eyebrow mb-4">{t('Family key')}</h1>
        {outcome === 'working' && <p className="text-sm text-muted">{t('Opening the key…')}</p>}
        {outcome === 'done' && (
          <p className="text-sm text-ink">
            {t('You hold the family key again on this device. It is also wrapped under your current password, so the next sign-in will not need a link.')}
          </p>
        )}
        {outcome === 'already' && <p className="text-sm text-ink">{t('This device already holds the family key.')}</p>}
        {outcome !== 'working' && outcome !== 'done' && outcome !== 'already' && (
          <p className="text-sm text-urgent">{outcome}</p>
        )}
        {outcome !== 'working' && (
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="mt-5 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:opacity-90"
          >
            {t('Continue')}
          </button>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import { planDay, usePlan } from '../lib/plan';
import { useServiceState } from '../lib/service';

/*
  Settings → Plan (#265): what the family's plan is, until when, and the
  two doors — subscribe, which opens the checkout on the apex (the hub's
  CSP admits no third-party script, so Paddle's runs there), and manage,
  which mints a customer-portal link on demand. Prices are named here as
  words only; the numbers live with the payment provider and the terms.
*/

const buttonClass =
  'rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-2';
const primaryClass =
  'rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover';

/* `trial_referred` is not a server state: the card says it when a trial
   carries referral days, so the longer date does not read as a mistake. */
function describe(state: string, until: string | null, deleteAt: string | null): string {
  const day = planDay(until);
  switch (state) {
    case 'trial':
      return t('Free period — until {day}. No card needed until then.', { day });
    case 'trial_referred':
      return t('Free period — until {day}, a month of it earned through referrals. No card needed until then.', { day });
    case 'legacy_free':
      return until
        ? t('Free, as promised to the first families — until {day}.', { day })
        : t('Free, as promised to the first families.');
    case 'active':
      return until ? t('Subscribed. Next renewal on {day}.', { day }) : t('Subscribed.');
    case 'grace':
      return t('The last payment did not go through. The hub keeps working until {day} while the payment is retried — check the card in the billing portal.', { day });
    case 'canceling':
      return t('Cancelled. The hub keeps working until {day}, the end of the paid period.', { day });
    default:
      return t('Read-only since {day}: everyone can sign in, read and export, nothing can be added or changed. The data is removed on {deleteDay} unless the family subscribes.', {
        day,
        deleteDay: planDay(deleteAt),
      });
  }
}

export function PlanSection() {
  const { user } = useAuth();
  const { state: service } = useServiceState();
  const eligible = user?.role === 'admin' && Boolean(service?.hosted) && !service?.demo;
  const plan = usePlan(eligible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!eligible || !plan) return null;

  const openPortal = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>('/family/plan/portal', {});
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not open the billing portal'));
    } finally {
      setBusy(false);
    }
  };

  const checkout = (which: 'monthly' | 'yearly') => {
    const url = new URL(plan.checkout_url);
    url.searchParams.set('plan', which);
    window.open(url.toString(), '_blank', 'noopener');
  };

  return (
    <section
      className={`rounded-card border p-5 ${plan.read_only ? 'border-urgent/40 bg-surface' : 'border-line bg-surface'}`}
    >
      <h2 className={`eyebrow mb-2 ${plan.read_only ? 'text-urgent' : ''}`}>{t('Plan')}</h2>
      <p className="mb-4 text-sm text-muted">
        {describe(
          plan.state === 'trial' && plan.bonus_days > 0 ? 'trial_referred' : plan.state,
          plan.until,
          plan.delete_at,
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {!plan.subscribed && (
          <>
            <button type="button" onClick={() => checkout('monthly')} className={primaryClass}>
              {t('Subscribe — monthly')}
            </button>
            <button type="button" onClick={() => checkout('yearly')} className={buttonClass}>
              {t('Subscribe — yearly, three months free')}
            </button>
          </>
        )}
        {plan.portal && (
          <button type="button" onClick={openPortal} disabled={busy} className={buttonClass}>
            {t('Manage subscription')}
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-urgent">{error}</p>}
      <p className="mt-3 text-xs text-muted">
        {t('One plan covers the whole family, however many of you there are. Payments are taken by Paddle; cancel anytime, refund within 14 days on request.')}
      </p>
    </section>
  );
}

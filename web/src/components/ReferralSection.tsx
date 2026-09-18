import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { plural } from '../lib/format';
import { useServiceState } from '../lib/service';

interface Referral {
  url: string;
  joined: number;
  subscribed: number;
  bonus_days: number;
}

/*
  Settings → the family's referral link (#336).

  Shown to every member, not only the administrator: inviting another
  household is not an administrative act, and the person most likely to
  send the link is whoever is talking to the other family.

  The card reports counts and never names. Which families arrived through
  this link is those households' own business — a line saying "the Petrovs
  joined" would be us telling one family that another exists.

  Hosted only: a self-hosted hub has one family, nothing to refer anyone to
  and no plan to shorten.
*/
export function ReferralSection() {
  const { state: service } = useServiceState();
  const eligible = Boolean(service?.hosted) && !service?.demo;
  const [data, setData] = useState<Referral | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!eligible) return;
    void api
      .get<Referral>('/family/referral')
      .then(setData)
      .catch(() => {});
  }, [eligible]);

  if (!eligible || !data) return null;

  async function copy() {
    if (!data) return;
    await navigator.clipboard.writeText(data.url);
    setCopied(true);
  }

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-2">{t('Invite another family')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('A family that starts here through your link gets two months free instead of one. When they subscribe, your own free period grows by a month.')}
      </p>

      <p className="break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-ink">
        {data.url}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-3"
        >
          {copied ? t('Copied') : t('Copy')}
        </button>
        {data.joined > 0 && (
          <span className="text-sm text-muted">
            {t('{n} joined through your link, {paid} subscribed.', {
              n: `${data.joined} ${plural(data.joined, 'family', 'families')}`,
              paid: String(data.subscribed),
            })}
          </span>
        )}
      </div>

      {data.bonus_days > 0 && (
        <p className="mt-3 text-sm text-ink">
          {t('You have earned {days} of free hub.', {
            days: `${data.bonus_days} ${plural(data.bonus_days, 'day', 'days')}`,
          })}
        </p>
      )}
    </section>
  );
}

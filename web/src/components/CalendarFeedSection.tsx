import { t } from '../lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Subscribe-by-URL for the calendar.
 *
 * The link is shown in full, every time — that is the point of storing it
 * in the clear (migration 026, same reasoning as the wishlist link): a
 * second device needs the same address a month later, and "revoke and
 * create a new one" is not an answer to "show it to me again".
 */
export function CalendarFeedSection() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<{ token: string | null }>('/calendar/feed');
    setToken(res.token);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Built from the current origin: the hub does not need to know its own
  // public address, and a family on a subdomain gets its own host for free.
  const url = token ? `${window.location.origin}/api/calendar/feed/${token}.ics` : null;

  async function create() {
    setBusy(true);
    try {
      const res = await api.post<{ token: string }>('/calendar/feed', {});
      setToken(res.token);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm(t('Every device subscribed to this link stops receiving updates. Revoke it?'))) {
      return;
    }
    setBusy(true);
    try {
      await api.delete('/calendar/feed');
      setToken(null);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
  }

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-2">{t('Subscribe in your calendar')}</h2>
      <p className="mb-4 text-sm text-muted">
        {t('Add the family calendar to the calendar app on your phone or laptop. The link is read-only and shows only what you can see in the hub.')}
      </p>

      {url ? (
        <>
          <p className="break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-ink">
            {url}
          </p>
          <p className="mt-2 text-sm text-muted">
            {t('Paste this address into Apple Calendar, Google Calendar or Outlook as a subscription.')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink hover:bg-surface-3"
            >
              {copied ? t('Copied') : t('Copy')}
            </button>
            <button
              type="button"
              onClick={() => void revoke()}
              disabled={busy}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-urgent hover:bg-surface-2"
            >
              {t('Revoke the link')}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          {t('Create the link')}
        </button>
      )}
    </section>
  );
}

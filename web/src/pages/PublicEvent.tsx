import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

/*
  One shared event, for people without an account — the second guest
  screen after the wishlist, and it follows the same rules.

  Rendered outside AppShell (no navigation, no session), and using fetch
  rather than lib/api on purpose: the shared client's 401 handling belongs
  to the signed-in app and must never fire here.

  What it shows is what the server sends, and the server sends only the
  event: no calendar name, no participants, nothing else from that day.
  A shared invitation is not a window into a household.
*/

interface SharedEvent {
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: number;
  recurrence_rule: string | null;
}

/** Local wall-clock in, human text out — no timezone conversion anywhere. */
function when(event: SharedEvent, locale: string): string {
  const date = new Date(event.starts_at);
  const day = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
  if (event.all_day) return day;

  const time = (value: string) =>
    new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  return `${day}, ${time(event.starts_at)} – ${time(event.ends_at)}`;
}

export function PublicEvent() {
  const { token } = useParams<{ token: string }>();
  const [event, setEvent] = useState<SharedEvent | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/event/${token}`);
      if (cancelled) return;
      if (!res.ok) {
        setDead(true);
        return;
      }
      setEvent((await res.json()) as SharedEvent);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (dead) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16">
        <h1 className="font-display text-2xl text-ink">Neiliro</h1>
        <p className="mt-4 text-sm text-muted">{t('This link is no longer valid')}</p>
      </main>
    );
  }
  if (!event) return null;

  const locale = document.documentElement.lang === 'ru' ? 'ru-RU' : 'en-GB';

  return (
    <main className="mx-auto max-w-lg px-5 py-16">
      <p className="eyebrow mb-2">{t('You are invited')}</p>
      <h1 className="font-display text-3xl text-ink">{event.title}</h1>

      <dl className="mt-6 space-y-3 text-sm">
        <div>
          <dt className="text-muted">{t('When')}</dt>
          <dd className="text-ink">{when(event, locale)}</dd>
        </div>
        {event.location && (
          <div>
            <dt className="text-muted">{t('Where')}</dt>
            <dd className="text-ink">{event.location}</dd>
          </div>
        )}
        {event.description && (
          <div>
            <dt className="text-muted">{t('Details')}</dt>
            <dd className="whitespace-pre-wrap text-ink">{event.description}</dd>
          </div>
        )}
      </dl>

      {/* A plain link, not a scripted download: the file is served with its
          own content-disposition, and this works in every browser */}
      <a
        href={`/api/event/${token}/ics`}
        className="mt-8 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        {t('Add to my calendar')}
      </a>
    </main>
  );
}

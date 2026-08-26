import { t } from '../lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

/*
  A shared list, for someone without an account — typically whoever is
  standing in the shop.

  Like the other guest screens it renders outside AppShell and uses fetch
  rather than lib/api, so the signed-in app's 401 handling never fires
  here. Unlike them it accepts one write: ticking an item off. A shopping
  list you cannot tick off is a screenshot, and the family sees the ticks
  because it is the same list, not a copy.
*/

interface GuestItem {
  id: string;
  title: string;
  checked_at: string | null;
  section_id: string | null;
}

interface GuestSection {
  id: string;
  title: string;
}

function GuestRows({
  items,
  onToggle,
}: {
  items: GuestItem[];
  onToggle: (item: GuestItem) => void;
}) {
  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface">
      {items.map((item) => (
        <li key={item.id} className="border-b border-line last:border-0">
          <button
            type="button"
            onClick={() => onToggle(item)}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors active:bg-surface-2"
          >
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded border ${
                item.checked_at ? 'border-accent bg-accent text-white' : 'border-line'
              }`}
            >
              {item.checked_at && (
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="m5 13 4 4 10-10" />
                </svg>
              )}
            </span>
            <span className={item.checked_at ? 'text-muted line-through' : 'text-ink'}>{item.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PublicList() {
  const { token } = useParams<{ token: string }>();
  const [title, setTitle] = useState<string | null>(null);
  const [items, setItems] = useState<GuestItem[]>([]);
  const [sections, setSections] = useState<GuestSection[]>([]);
  const [dead, setDead] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/list/${token}`);
    if (!res.ok) {
      setDead(true);
      return;
    }
    const body = (await res.json()) as {
      title: string;
      items: GuestItem[];
      sections: GuestSection[];
    };
    setTitle(body.title);
    setItems(body.items);
    setSections(body.sections ?? []);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(item: GuestItem) {
    // Optimistic, then reconciled: a shop is exactly where a spinner per
    // tap is worst
    setItems((current) =>
      current.map((i) => (i.id === item.id ? { ...i, checked_at: i.checked_at ? null : 'pending' } : i)),
    );
    const res = await fetch(`/api/list/${token}/items/${item.id}/toggle`, { method: 'POST' });
    if (!res.ok) setDead(!res.ok && res.status === 404);
    await load();
  }

  if (dead) {
    return (
      <main className="mx-auto max-w-lg px-5 py-16">
        <h1 className="font-display text-2xl text-ink">Neiliro</h1>
        <p className="mt-4 text-sm text-muted">{t('This link is no longer valid')}</p>
      </main>
    );
  }
  if (title === null) return null;

  const open = items.filter((i) => !i.checked_at);
  const checked = items.filter((i) => i.checked_at);
  // Reading by aisle is why sections exist, and the guest is usually the
  // one holding the phone in the shop — so the grouping travels here too
  const loose = open.filter((i) => !i.section_id);

  return (
    <main className="mx-auto max-w-lg px-5 py-12">
      <p className="eyebrow mb-2">{t('Shared list')}</p>
      <h1 className="font-display text-3xl text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">{t('Tick things off as you go — the family sees it too.')}</p>

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-muted">{t('This list is empty.')}</p>
      ) : (
        <>
          {loose.length > 0 && <GuestRows items={loose} onToggle={(i) => void toggle(i)} />}
          {sections.map((section) => {
            const inSection = open.filter((i) => i.section_id === section.id);
            if (inSection.length === 0) return null;
            return (
              <section key={section.id} className="mt-6">
                <h2 className="eyebrow mb-2">{section.title}</h2>
                <GuestRows items={inSection} onToggle={(i) => void toggle(i)} />
              </section>
            );
          })}
          {checked.length > 0 && (
            <div className="mt-6">
              <GuestRows items={checked} onToggle={(i) => void toggle(i)} />
            </div>
          )}
        </>
      )}
    </main>
  );
}

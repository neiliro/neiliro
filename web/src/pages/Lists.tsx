import { t } from '../lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Empty, Page } from '../components/Page';
import { onEnter } from '../lib/keys';
import { listTitle, type ListItem, type ListWithItems, type SharedList } from '../lib/lists';

/*
  Shared lists (#11) — the shopping list and its friends.

  The requirement was speed on a phone, so the interactions are optimistic:
  a tap moves the row immediately and the request follows. A list is small
  and the operations are trivial, so the honest failure mode is "reload and
  show the truth" rather than a spinner on every checkbox. The input keeps
  focus after adding, because the real gesture is three items in a row.
*/
export function Lists() {
  const [lists, setLists] = useState<SharedList[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [list, setList] = useState<ListWithItems | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  /*
    Items typed but not yet confirmed by the server, as plain titles. Not
    placeholder rows with invented ids: a fake id needs a counter, and every
    way to keep one here (a ref, a module variable, the clock) is something
    the React lint rules correctly refuse in an event path. Titles are
    enough — these rows are not interactive, and the reload replaces them.
  */
  const [pending, setPending] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadLists = useCallback(async () => {
    const all = await api.get<SharedList[]>('/lists');
    setLists(all);
    setActiveId((current) => current ?? all[0]?.id ?? null);
  }, []);

  const loadList = useCallback(async (id: string) => {
    setList(await api.get<ListWithItems>(`/lists/${id}`));
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (activeId) void loadList(activeId);
  }, [activeId, loadList]);

  useEffect(() => {
    // Arrived from the phone's quick actions: land in the input, not on the page
    if (new URLSearchParams(window.location.search).get('add') === '1') {
      inputRef.current?.focus();
    }
  }, [list]);

  async function addItem() {
    const title = draft.trim();
    if (!title || !activeId) return;
    setDraft('');
    setError(null);
    // The row shows immediately; the request follows
    setPending((p) => [...p, title]);
    try {
      await api.post(`/lists/${activeId}/items`, { title });
      await Promise.all([loadList(activeId), loadLists()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong'));
      void loadList(activeId);
    } finally {
      setPending((p) => p.filter((x) => x !== title));
    }
  }

  async function toggle(item: ListItem) {
    if (!activeId) return;
    setList((l) =>
      l
        ? {
            ...l,
            items: l.items.map((i) =>
              // A marker, not a real timestamp: this row is replaced by the
              // server's answer a moment later, and until then only
              // "checked or not" is read from it
              i.id === item.id ? { ...i, checked_at: i.checked_at ? null : 'pending' } : i,
            ),
          }
        : l,
    );
    try {
      await api.post(`/list-items/${item.id}/toggle`, {});
      await Promise.all([loadList(activeId), loadLists()]);
    } catch {
      void loadList(activeId);
    }
  }

  async function clearChecked() {
    if (!activeId) return;
    await api.post(`/lists/${activeId}/clear-checked`, {});
    await Promise.all([loadList(activeId), loadLists()]);
  }

  async function newList() {
    const title = window.prompt(t('Name of the new list')) ?? '';
    if (!title.trim()) return;
    const made = await api.post<SharedList>('/lists', { title: title.trim() });
    await loadLists();
    setActiveId(made.id);
  }

  // The open list names the page: with a single list there are no chips to
  // switch between, so the heading is the only place its name can show.
  const open = list?.items.filter((i) => !i.checked_at) ?? [];
  const checked = list?.items.filter((i) => i.checked_at) ?? [];

  return (
    <Page
      title={list ? listTitle(list.id, list.title) : t('Lists')}
      eyebrow={t('Shared with the whole family')}
      action={
        <button
          type="button"
          onClick={() => void newList()}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2"
        >
          {t('New list')}
        </button>
      }
    >
      {lists.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {lists.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setActiveId(l.id)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                l.id === activeId
                  ? 'border-accent bg-accent-soft text-ink'
                  : 'border-line bg-surface text-muted hover:bg-surface-2'
              }`}
            >
              {listTitle(l.id, l.title)}
              {l.open_items > 0 && <span className="ml-1.5 font-mono text-xs">{l.open_items}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="max-w-xl">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onEnter(() => void addItem())}
          placeholder={t('Add an item and press Enter')}
          className="w-full rounded-card border border-line bg-surface px-4 py-3 text-base text-ink outline-none focus:border-accent"
        />
        {error && <p className="mt-2 text-sm text-urgent">{error}</p>}

        {open.length === 0 && checked.length === 0 && pending.length === 0 ? (
          <div className="mt-4">
            <Empty>{t('Nothing here yet. Add the first item above.')}</Empty>
          </div>
        ) : (
          <ul className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
            {pending.map((title, i) => (
              <li key={`pending-${i}`} className="border-b border-line last:border-0">
                <span className="flex items-center gap-3 px-4 py-3 text-muted">
                  <span className="size-5 shrink-0 rounded border border-line" />
                  {title}
                </span>
              </li>
            ))}
            {[...open, ...checked].map((item) => (
              <li key={item.id} className="border-b border-line last:border-0">
                <button
                  type="button"
                  onClick={() => void toggle(item)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-surface-2"
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
                  <span className={item.checked_at ? 'text-muted line-through' : 'text-ink'}>
                    {item.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {checked.length > 0 && (
          <button
            type="button"
            onClick={() => void clearChecked()}
            className="mt-3 text-sm text-muted underline hover:text-ink"
          >
            {t('Clear checked ({n})', { n: String(checked.length) })}
          </button>
        )}
      </div>
    </Page>
  );
}

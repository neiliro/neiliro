import { t } from '../lib/i18n';
import { clearBlankOnBlur } from '../lib/forms';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate } from '../lib/format';
import { projectTitle } from '../lib/tasks';
import { search, type SearchResult as Result } from '../lib/search';

const KIND_LABEL: Record<Result['kind'], string> = {
  task: t('Task'),
  note: t('Note'),
  event: t('Event'),
  project: t('Project'),
  attachment: t('File'),
};

/*
  Subtitles come from the server in English. User-given names (project,
  folder) must not be translated, while built-in constants must be. We only
  translate a known finite list; task project names are handled by projectTitle by id.
*/
const SERVER_SUBTITLES = new Set(['Private', 'No folder', 'Project']);

function subtitleOf(r: Result): string {
  if (r.kind === 'task') return projectTitle(r.project_id, r.subtitle);
  return SERVER_SUBTITLES.has(r.subtitle) ? t(r.subtitle) : r.subtitle;
}

/**
 * The sidebar trigger, separated from the modal. The modal must be
 * mounted at the shell root: it used to live inside the sidebar, and on
 * phones the sidebar is display:none — which hides even a fixed-position
 * child, so search silently did nothing outside the desktop layout.
 */
export function SearchTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm text-muted transition-colors hover:text-ink"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" strokeLinecap="round" />
      </svg>
      {t('Search')}
    </button>
  );
}

export function GlobalSearch({
  open: openProp,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  // useCallback is mandatory: setOpen is a dependency of the effect with
  // the window handler — an unstable identity would recreate the
  // subscription on every render (the classic unstable-hooks trap)
  const setOpen = useCallback(
    (value: boolean) => {
      setOpenLocal(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd+K is already taken by quick add, so search lives on Cmd+Shift+F.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Debounced, and in the browser (#216): the server hands over the rows
  // this person may see, the matching runs on decrypted text here
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults(null);
      setHint(trimmed.length === 0 ? null : t('At least three characters are needed'));
      return;
    }
    const timer = setTimeout(() => {
      void search(trimmed)
        .then((found) => {
          setResults(found);
          setCursor(0);
          setHint(found.length === 0 ? t('Nothing found') : null);
        })
        .catch((err: Error) => setHint(err.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open]);

  function go(result: Result) {
    setOpen(false);
    setQuery('');
    if (result.url.startsWith('/api/')) window.open(result.url, '_blank');
    else navigate(result.url);
  }

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-5 pt-20">
          <button
            type="button"
            aria-label={t('Close')}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />

          <div className="relative flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-card border border-line bg-surface shadow-xl">
            <input
              ref={inputRef}
              value={query}
              placeholder={t('Search tasks, notes, events and files')}
              onChange={(e) => setQuery(e.target.value)}
              onBlur={clearBlankOnBlur(() => setQuery(''))}
              onKeyDown={(e) => {
                if (!results?.length) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, results.length - 1));
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const chosen = results[cursor];
                  if (chosen) go(chosen);
                }
              }}
              className="border-b border-line bg-transparent px-5 py-4 text-base text-ink outline-none"
            />

            {hint && <p className="px-5 py-4 text-sm text-muted">{hint}</p>}

            {results && results.length > 0 && (
              <ul className="overflow-y-auto">
                {results.map((r, index) => (
                  <li key={`${r.kind}-${r.id}`}>
                    <button
                      type="button"
                      onClick={() => go(r)}
                      onMouseEnter={() => setCursor(index)}
                      className={`flex w-full items-center gap-3 border-b border-line px-5 py-3 text-left last:border-0 ${
                        index === cursor ? 'bg-accent-soft' : ''
                      }`}
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: r.color ?? 'var(--c-text-muted)' }}
                        aria-hidden
                      />

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {r.kind === 'project' ? projectTitle(r.id, r.title) : r.title}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {KIND_LABEL[r.kind]} · {subtitleOf(r)}
                          {r.excerpt && ` · ${r.excerpt}`}
                        </span>
                      </span>

                      {r.badge && (
                        <span className="shrink-0 font-mono text-xs text-muted">
                          {formatDate(r.badge)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="border-t border-line px-5 py-2.5 font-mono text-xs text-muted">
              {t('Cmd + Shift + F · arrows and Enter')}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

import { t } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { api, type HouseholdMember, type Project, type Task } from '../lib/api';
import { onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';
import { TaskDetail } from './TaskDetail';
import { ScrollLock } from './Dialog';
import { INBOX_ID, projectTitle } from '../lib/tasks';

/**
 * Quick add via Cmd/Ctrl+K from anywhere.
 * A task with no project selected goes to Inbox — triage later;
 * what matters is not losing the thought the moment it arrives.
 */
export function QuickAdd({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(INBOX_ID);
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  // A created task opens for editing right away:
  // due date, assignee and priority are easiest to set while it's fresh.
  const [created, setCreated] = useState<Task | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    // External open — from the quick actions screen on the phone
    const openIt = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('hub:quick-add', openIt);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hub:quick-add', openIt);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    void api.get<Project[]>('/projects').then(setProjects);
    void api.get<HouseholdMember[]>('/household').then(setMembers);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  async function submit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const task = await api.post<Task>('/tasks', {
        project_id: projectId,
        title: trimmed,
        due_date: dueDate || null,
      });
      setTitle('');
      setDueDate('');
      setOpen(false);
      onAdded();
      setCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not add'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-5 bottom-[calc(6rem+var(--vv-bottom,0px))] z-20 grid size-13 place-items-center rounded-full bg-accent text-2xl text-white shadow-lg md:right-8 md:bottom-8"
        aria-label={t('Add task')}
      >
        +
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex items-start justify-center px-5 pt-3 md:pt-24">
          {/* Same reason as GlobalSearch: the page must not scroll under a
              focused input in a fixed overlay, or the form slides off-screen */}
          <ScrollLock />
          <button
            type="button"
            aria-label={t('Close')}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="relative w-full max-w-lg rounded-card border border-line bg-surface p-5 shadow-xl">
            <h2 className="eyebrow mb-4">{t('New task')}</h2>

            <input
              ref={inputRef}
              value={title}
              placeholder={t('Things to do')}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={clearBlankOnBlur(() => setTitle(''))}
              onKeyDown={onEnter(() => void submit())}
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
            />

            <div className="mt-3 grid gap-3 *:min-w-0 sm:grid-cols-2">
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                onKeyDown={onEnter(() => void submit())}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {projectTitle(p.id, p.title)}
                  </option>
                ))}
              </select>

              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                onKeyDown={onEnter(() => void submit())}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              />
            </div>

            {error && <p className="mt-3 text-sm text-urgent">{error}</p>}

            <div className="mt-4 flex items-center justify-between">
              <span className="font-mono text-xs text-muted">Cmd + K</span>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {t('Add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {created && (
        <TaskDetail
          task={created}
          members={members}
          onSaved={onAdded}
          onClose={() => setCreated(null)}
        />
      )}
    </>
  );
}

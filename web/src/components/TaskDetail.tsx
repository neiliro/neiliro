import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { api, type HouseholdMember, type Task, type TaskMutation } from '../lib/api';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  RECURRENCE_OPTIONS,
  STATUSES,
  STATUS_LABEL,
  LEVEL_LABEL,
} from '../lib/tasks';
import { dialogKeys, onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';
import { inlineDanger, useDialogs, useScrollLock } from './Dialog';

const field =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
const label = 'mb-1.5 block text-sm font-medium text-ink';

interface Props {
  task: Task;
  members: HouseholdMember[];
  onSaved: () => void;
  onClose: () => void;
}

export function TaskDetail({ task, members, onSaved, onClose }: Props) {
  const dialogs = useDialogs();
  const [draft, setDraft] = useState({
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    due_date: task.due_date ?? '',
    expected_date: task.expected_date ?? '',
    assignee_id: task.assignee_id ?? '',
    recurrence_rule: task.recurrence_rule ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spawnedDate, setSpawnedDate] = useState<string | null>(null);

  // No dependency list: the subscription is refreshed on every render,
  // so save always sees the current draft
  useEffect(() => {
    const onKey = dialogKeys(() => {
      if (!busy) void save();
    }, onClose);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.patch<TaskMutation>(`/tasks/${task.id}`, {
        title: draft.title,
        description: draft.description || null,
        status: draft.status,
        priority: draft.priority,
        due_date: draft.due_date || null,
        expected_date: draft.expected_date || null,
        assignee_id: draft.assignee_id || null,
        recurrence_rule: draft.recurrence_rule || null,
      });
      if (res.spawned) {
        setSpawnedDate(res.spawned.due_date);
        onSaved();
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const children = task.child_count ?? 0;
    const ok = await dialogs.confirm({
      title: t('Delete task'),
      message: children
        ? t('Its nested tasks will be deleted with it: {n}.', { n: children })
        : task.title,
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/tasks/${task.id}`);
    onSaved();
    onClose();
  }

  useScrollLock();

  /*
    Deliberately NOT the shared Modal (#84): this is a right-hand
    slide-over — full height, its own header with a Close, content that
    scrolls inside the panel — not a centred titled card with a footer.
    Teaching Modal a drawer variant for one caller would cost more than
    the duplication it removes. What the shells really share is behaviour,
    and that comes from the same places Modal takes it: dialogKeys above,
    the scroll lock here.
  */
  return (
    <div className="fixed inset-0 z-30 flex justify-end overscroll-contain">
      <button
        type="button"
        aria-label={t('Close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-line bg-surface">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <span className="eyebrow">{LEVEL_LABEL[task.level]}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted hover:text-ink"
          >
            {t('Close')}
          </button>
        </header>

        {spawnedDate && (
          <p className="border-b border-line bg-accent-soft px-5 py-3 text-sm text-ink">
            {t('Task closed. The next occurrence is scheduled for {date}.', { date: spawnedDate })}
          </p>
        )}

        <div className="flex-1 space-y-4 px-5 py-5">
          <label className="block">
            <span className={label}>{t('Name')}</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onBlur={clearBlankOnBlur(() => setDraft({ ...draft, title: '' }))}
              onKeyDown={onEnter(() => void save())}
              className={field}
            />
          </label>

          <label className="block">
            <span className={label}>{t('Description')}</span>
            <textarea
              rows={4}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              onBlur={clearBlankOnBlur(() => setDraft({ ...draft, description: '' }))}
              className={`${field} resize-y`}
            />
          </label>

          <div className="grid grid-cols-2 gap-3 *:min-w-0">
            <label className="block">
              <span className={label}>{t('Status')}</span>
              <select
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value as Task['status'] })}
                className={field}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={label}>{t('Priority')}</span>
              <select
                value={draft.priority}
                onChange={(e) =>
                  setDraft({ ...draft, priority: e.target.value as Task['priority'] })
                }
                className={field}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={label}>{t('Due date')}</span>
              <input
                type="date"
                value={draft.due_date}
                onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
                className={field}
              />
            </label>

            <label className="block">
              <span className={label}>{t('Expected finish')}</span>
              <input
                type="date"
                value={draft.expected_date}
                onChange={(e) => setDraft({ ...draft, expected_date: e.target.value })}
                className={field}
              />
              {draft.expected_date && (
                <span className="mt-1 block text-xs text-muted">
                  {t('Overdue counts from this date')}
                </span>
              )}
            </label>

            <label className="block">
              <span className={label}>{t('Assignee')}</span>
              <select
                value={draft.assignee_id}
                onChange={(e) => setDraft({ ...draft, assignee_id: e.target.value })}
                className={field}
              >
                <option value="">{t('Unassigned')}</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className={label}>{t('Recurrence')}</span>
            <select
              value={draft.recurrence_rule}
              onChange={(e) => setDraft({ ...draft, recurrence_rule: e.target.value })}
              className={field}
            >
              {RECURRENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {draft.recurrence_rule && !draft.due_date && (
              <span className="mt-1 block text-xs text-urgent">
                {t('Recurrence counts from the due date — set one')}
              </span>
            )}
          </label>

          {error && <p className="text-sm text-urgent">{error}</p>}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-4">
          <button
            type="button"
            onClick={() => void remove()}
            className={`${inlineDanger} text-sm`}
          >
            {t('Delete')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('Saving') : t('Save')}
          </button>
        </footer>
      </div>
    </div>
  );
}

import { t } from './i18n';
import { dayIn, familyTimezone } from './timezone';
import type { Task } from './api';

export const STATUSES = ['backlog', 'todo', 'in_progress', 'done', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  backlog: t('Someday'),
  todo: t('To do'),
  in_progress: t('In progress'),
  done: t('Done'),
  cancelled: t('Cancelled'),
};

/** Board columns. «Cancelled» is not shown on the board — it is an outcome, not a stage. */
export const BOARD_COLUMNS: Status[] = ['backlog', 'todo', 'in_progress', 'done'];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: t('Low'),
  normal: t('Normal'),
  high: t('High'),
  urgent: t('Urgent'),
};

export const LEVEL_LABEL = [t('Story'), t('Task'), t('Subtask')] as const;

export const RECURRENCE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: t('Does not repeat') },
  { value: 'FREQ=DAILY', label: t('Every day') },
  { value: 'FREQ=WEEKLY', label: t('Every week') },
  { value: 'FREQ=WEEKLY;INTERVAL=2', label: t('Every two weeks') },
  { value: 'FREQ=MONTHLY', label: t('Every month') },
  { value: 'FREQ=MONTHLY;INTERVAL=3', label: t('Every quarter') },
  { value: 'FREQ=YEARLY', label: t('Every year') },
];

/** The default project — the only one whose id is known in advance (migration 004). */
export const INBOX_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Project title for display. The Inbox is seeded data, not UI, so the t()
 * dictionary never sees it. The project is unique and known by its fixed
 * id — translate in place (English seed since migration 013).
 */
export function projectTitle(id: string | null | undefined, title: string): string {
  // Same guard as calendarName: translate the seeded name, leave a renamed
  // one alone. Inbox cannot be archived or deleted, but it can be renamed,
  // so without this a rename looked like it had failed.
  return id === INBOX_ID && (title === 'Inbox' || title === 'Входящие') ? t('Inbox') : title;
}

export interface TaskNode extends Task {
  children: TaskNode[];
}

/**
 * Turn the flat list into a tree, keeping the server response order.
 * Tasks whose parent got filtered out are promoted to the top level —
 * otherwise they would silently vanish, and a person would assume they
 * do not exist.
 */
export function buildTree(tasks: Task[]): TaskNode[] {
  const nodes = new Map<string, TaskNode>();
  for (const task of tasks) nodes.set(task.id, { ...task, children: [] });

  const roots: TaskNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.id)!;
    const parent = task.parent_id ? nodes.get(task.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * The date a task actually lives on. due_date says when it should be
 * done; expected_date says when it is realistically going to be done
 * (a repair known to take a week). When set, the expected date drives
 * overdue and every date-keyed view — in-progress work with a known
 * finish day is not "overdue", it is scheduled for that day.
 */
export function effectiveDate(task: Task): string | null {
  return task.expected_date ?? task.due_date;
}

export function isOverdue(task: Task, today: string): boolean {
  const date = effectiveDate(task);
  return Boolean(date && date < today && !isClosed(task));
}

export function isClosed(task: Task): boolean {
  return task.status === 'done' || task.status === 'cancelled';
}

/**
 * Today for the family, not for this browser — a member in another zone has
 * to see the same board as everyone at home. Matches today() on the server.
 */
export function today(): string {
  return dayIn(familyTimezone(), new Date());
}

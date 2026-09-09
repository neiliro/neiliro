import { t } from './i18n';
import { decodeResponse, encodeRequest } from './codec';
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/*
  Every body goes through the codec before it leaves and every answer
  before it is returned (lib/codec.ts, ADR 0001): fields the family
  encrypts are sealed and opened here, so the pages above keep speaking
  plaintext. A codec refusal (this device holds no key while the family
  has one) surfaces as an ordinary error message.
*/
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const encoded = body === undefined ? undefined : await encodeRequest(method, path, body);
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(encoded === undefined ? {} : { body: JSON.stringify(encoded) }),
  });
  if (!res.ok) {
    // A dead session must take the offline caches with it: after a
    // remote "sign out everywhere" the lost device would otherwise keep
    // serving cached family data for days. Same set logout clears.
    if (res.status === 401 && 'caches' in window) {
      for (const name of ['api-reads', 'attachments', 'session']) {
        void caches.delete(name);
      }
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(t(body?.error ?? 'The server is unreachable'), res.status);
  }
  return (await decodeResponse(method, path, await res.json())) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, 'POST', body),
  patch: <T>(path: string, body: unknown) => request<T>(path, 'PATCH', body),
  put: <T>(path: string, body: unknown) => request<T>(path, 'PUT', body),
  delete: <T>(path: string) => request<T>(path, 'DELETE'),
};

// ── Types shared with the server ──────────────────────────────────────────

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  level: 0 | 1 | 2;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  expected_date: string | null;
  assignee_id: string | null;
  recurrence_rule: string | null;
  position: number;
  project_title?: string;
  project_color?: string;
  assignee_name?: string | null;
  assignee_color?: string | null;
  child_count?: number;
  child_done?: number;
}

export interface Project {
  id: string;
  title: string;
  description: string | null;
  color: string;
  icon: string | null;
  position: number;
  archived_at: string | null;
  open_tasks: number;
  total_tasks: number;
}

export interface HouseholdMember {
  id: string;
  name: string;
  color: string;
}

/** Response to a task mutation: the task itself plus the spawned recurrence, if any. */
export interface TaskMutation {
  task: Task;
  spawned: Task | null;
}

export interface NoteStub {
  id: string;
  title: string;
  updated_at: string;
}

export interface Dashboard {
  today: string;
  dueToday: Task[];
  overdue: Task[];
  upcoming: Task[];
  recentNotes: NoteStub[];
  todayEvents: import('./calendar').Occurrence[];
  reminders: import('./calendar').Occurrence[];
  settings: Record<string, string>;
}

import { api } from './api';
import { today } from './tasks';

/*
  Everything this person can see, as one JSON file (GDPR art. 15 and 20:
  access and portability). The family archive in Settings is the
  administrator's and holds every member's rows; a member's copy has to be
  theirs alone, and it has to be readable — which rules out dumping the
  database, where the words are ciphertext.

  So it is assembled here, in the browser, through the same endpoints the
  pages use: the server applies the same visibility rules it always does
  (a private note of someone else is never in the answer), and the codec
  in api.ts opens the envelopes on the way in, so the file holds words. No
  second export path on the server, no second copy of the privacy rules.

  Money and the calendar are windowed: the server caps a transaction list
  at 500 rows and an occurrence range at 400 days, so a window that comes
  back full is split in two until every row is in.
*/

const TX_CAP = 500;

function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

async function transactionsBetween(from: string, to: string): Promise<unknown[]> {
  const rows = await api.get<unknown[]>(`/transactions?from=${from}&to=${to}&limit=${TX_CAP}`);
  if (rows.length < TX_CAP || daysBetween(from, to) < 1) return rows;
  const mid = shiftDays(from, Math.floor(daysBetween(from, to) / 2));
  return [...(await transactionsBetween(from, mid)), ...(await transactionsBetween(shiftDays(mid, 1), to))];
}

async function tryGet<T>(path: string): Promise<T | { unavailable: string }> {
  try {
    return await api.get<T>(path);
  } catch (err) {
    // A module that is switched off (mail on a hub without a mailbox) or a
    // section this role may not open answers with an error; the file says
    // so in that slot rather than failing as a whole
    return { unavailable: err instanceof Error ? err.message : String(err) };
  }
}

export interface MyData {
  exported_at: string;
  scope: string;
  account: unknown;
  sessions: unknown;
  profile: unknown;
  notes: unknown[];
  projects: unknown;
  tasks: unknown;
  calendar: { from: string; to: string; occurrences: unknown[] };
  money: { accounts: unknown; categories: unknown; transactions: unknown[]; recurring: unknown; budgets: unknown };
  lists: unknown[];
  mail: unknown;
}

export async function collectMyData(userId: string): Promise<MyData> {
  const now = today();
  const account = await api.get<unknown>('/auth/me');
  const sessions = await tryGet('/auth/sessions');
  const profile = await tryGet(`/profiles/${userId}`);

  const noteHeads = await api.get<{ id: string }[]>('/notes?limit=2000');
  const notes: unknown[] = [];
  for (const head of noteHeads) notes.push(await api.get<unknown>(`/notes/${head.id}`));

  const projects = await tryGet('/projects');
  const tasks = await tryGet('/tasks?include_done=true&limit=2000');

  const from = shiftDays(now, -365);
  const to = shiftDays(now, 365);
  const occurrences = [
    ...(await api.get<unknown[]>(`/events?from=${from}&to=${now}`)),
    ...(await api.get<unknown[]>(`/events?from=${shiftDays(now, 1)}&to=${to}`)),
  ];

  const accounts = await tryGet('/accounts');
  const categories = await tryGet('/categories');
  const transactions = await transactionsBetween('2000-01-01', shiftDays(now, 366));
  const recurring = await tryGet('/recurring');
  const budgets = await tryGet('/budgets');

  const listHeads = await api.get<{ id: string }[]>('/lists');
  const lists: unknown[] = [];
  for (const head of listHeads) lists.push(await api.get<unknown>(`/lists/${head.id}`));

  const mail = await tryGet('/mail');

  return {
    exported_at: new Date().toISOString(),
    scope:
      'Everything this account can see in the hub, decrypted: shared rows of the family and this member’s own private rows. Other members’ private rows are not here because this account cannot see them. Files are not included; they download from the hub.',
    account,
    sessions,
    profile,
    notes,
    projects,
    tasks,
    calendar: { from, to, occurrences },
    money: { accounts, categories, transactions, recurring, budgets },
    lists,
    mail,
  };
}

/** Hands the browser a JSON file to save. */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

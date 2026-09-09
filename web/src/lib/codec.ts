import { ENCRYPTED_FIELDS } from './crypto/field-map';
import { isEncrypted } from './crypto/envelope';
import { excerptOf, extractLinks, normalizeWikiLinks } from './notes';
import { openFields, openRows, sealFields } from './vault';

/*
  Encrypt on the way out, decrypt on the way in (ADR 0001, phase 2).

  lib/api.ts hands every request body and every response through here. A
  route table says which fields of which table travel in which shape, so a
  module page keeps calling `api.get('/notes')` and receives readable rows
  — the only place that knows a note's title is an envelope is this file
  and the field map next to it.

  Two things the codec does beyond ciphering, both because the server lost
  the ability to do them for encrypted rows:

  - It mints the row id for a create. The envelope's authenticated data
    names the row (table/column/id), so the id must exist before the first
    byte is encrypted; the server accepts the browser's id and refuses a
    duplicate.
  - For notes it derives what the server used to derive from the body: the
    list preview and the [[link]] rows, resolved against the titles this
    tab has seen. The registry below is fed by every decoded list.
*/

type Row = Record<string, unknown>;
type Body = Record<string, unknown>;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NOTE = new RegExp(`^/notes/(${UUID})(?:\\?.*)?$`);
const NOTE_VERSIONS = new RegExp(`^/notes/(${UUID})/versions(?:\\?.*)?$`);
const NOTE_VERSION = new RegExp(`^/notes/(${UUID})/versions/(${UUID})$`);
const NOTE_RESTORE = new RegExp(`^/notes/(${UUID})/restore/${UUID}$`);
const NOTE_DAILY = /^\/notes\/daily\/\d{4}-\d{2}-\d{2}$/;
const NOTES_LIST = /^\/notes(?:\?.*)?$/;
const TASKS_LIST = /^\/tasks(?:\?.*)?$/;
const TASK = new RegExp(`^/tasks/(${UUID})$`);
const PROJECTS_LIST = /^\/projects(?:\?.*)?$/;
const PROJECT = new RegExp(`^/projects/(${UUID})$`);
const EVENTS_LIST = /^\/events(?:\?.*)?$/;
const EVENT = new RegExp(`^/events/(${UUID})$`);
const CALENDARS_LIST = /^\/calendars(?:\?.*)?$/;
const CALENDAR = new RegExp(`^/calendars/(${UUID})$`);
const ACCOUNTS_LIST = /^\/accounts(?:\?.*)?$/;
const ACCOUNT = new RegExp(`^/accounts/(${UUID})$`);
const RECONCILE = new RegExp(`^/accounts/(${UUID})/reconcile$`);
const CATEGORIES_LIST = /^\/categories(?:\?.*)?$/;
const CATEGORY = new RegExp(`^/categories/(${UUID})$`);
const TRANSACTIONS_LIST = /^\/transactions(?:\?.*)?$/;
const TRANSACTION = new RegExp(`^/transactions/(${UUID})$`);
const RECURRING_LIST = /^\/recurring$/;
const RECURRING = new RegExp(`^/recurring/(${UUID})$`);
const RECURRING_CONFIRM = new RegExp(`^/recurring/(${UUID})/confirm$`);
const LISTS_LIST = /^\/lists$/;
const LIST = new RegExp(`^/lists/(${UUID})$`);
const LIST_ITEMS = new RegExp(`^/lists/(${UUID})/items$`);
const LIST_SECTIONS = new RegExp(`^/lists/(${UUID})/sections$`);
const LIST_ITEM = new RegExp(`^/list-items/(${UUID})$`);
const LIST_ITEM_ANY = new RegExp(`^/list-items/(${UUID})(?:/toggle|/section)?$`);
const LIST_SECTION = new RegExp(`^/list-sections/(${UUID})$`);
const PROFILES_LIST = /^\/profiles$/;
const PROFILE = new RegExp(`^/profiles/(${UUID})$`);
const PROFILE_ENTRIES = new RegExp(`^/profiles/(${UUID})/entries$`);
const PROFILE_ENTRY = new RegExp(`^/profiles/(${UUID})/entries/(${UUID})$`);
const TRANSACTION_ATTACHMENTS = new RegExp(`^/transactions/(${UUID})/attachments$`);
const MAIL_MESSAGE = new RegExp(`^/mail/(${UUID})$`);

const F = ENCRYPTED_FIELDS;

// ── Titles this tab has seen, for resolving [[links]] in the browser ──────

const noteTitles = new Map<string, string>(); // lower-cased title → note id

/** Ids of rows that arrived as plaintext — what the one-time job still has to encrypt. */
const plaintextSeen = new Map<string, Set<string>>();

function rememberNote(row: Row): void {
  if (typeof row['title'] === 'string' && typeof row['id'] === 'string') {
    noteTitles.set(row['title'].toLowerCase(), row['id']);
  }
}

function markPlaintext(table: string, key: string, sample: unknown): void {
  const set = plaintextSeen.get(table) ?? new Set<string>();
  if (typeof sample === 'string' && !isEncrypted(sample)) set.add(key);
  else set.delete(key);
  plaintextSeen.set(table, set);
}

function notePlaintext(raw: Row): void {
  if (typeof raw['id'] === 'string') markPlaintext('notes', raw['id'], raw['title']);
}

export function noteIdByTitle(title: string): string | null {
  return noteTitles.get(title.trim().toLowerCase()) ?? null;
}

export function pendingPlaintext(table: string): string[] {
  return [...(plaintextSeen.get(table) ?? [])];
}

/** The link rows for a body, resolved against the titles known here. */
export function linksFor(body: string): { title: string; target_note_id: string | null }[] {
  return extractLinks(body).map((title) => ({ title, target_note_id: noteIdByTitle(title) }));
}

// ── Notes ─────────────────────────────────────────────────────────────────

async function sealNoteBody(id: string, body: Body): Promise<Body> {
  const out: Body = { ...body };
  if (typeof out['body_md'] === 'string') {
    const text = normalizeWikiLinks(out['body_md']);
    out['body_md'] = text;
    out['excerpt'] = excerptOf(text);
    if (out['links'] === undefined) out['links'] = linksFor(text);
  }
  const sealed = await sealFields('notes', id, out, F['notes']!);
  if (Array.isArray(sealed['links'])) {
    // The wire shape is {title, target_note_id}; the column the title lands
    // in is note_links.target_title, and that is what the AAD has to name
    sealed['links'] = await Promise.all(
      (sealed['links'] as Row[]).map(async (link) => {
        const row = await sealFields(
          'note_links',
          id,
          { target_title: link['title'], target_note_id: link['target_note_id'] ?? null },
          F['note_links']!,
        );
        return { title: row['target_title'], target_note_id: row['target_note_id'] };
      }),
    );
  }
  return sealed;
}

async function openNote(row: Row): Promise<Row> {
  const id = String(row['id']);
  notePlaintext(row);
  const opened = await openFields('notes', id, row, F['notes']!);
  rememberNote(opened);
  if (Array.isArray(opened['outgoing'])) {
    opened['outgoing'] = await openRows('note_links', opened['outgoing'] as Row[], F['note_links']!, () => id);
  }
  if (Array.isArray(opened['backlinks'])) {
    opened['backlinks'] = await openRows('notes', opened['backlinks'] as Row[], ['title']);
  }
  if (Array.isArray(opened['attachments'])) {
    opened['attachments'] = await openList('attachments', opened['attachments'] as Row[]);
  }
  return opened;
}

async function openNoteList(rows: Row[]): Promise<Row[]> {
  const opened = await Promise.all(rows.map((row) => openNote(row)));
  return opened;
}

// ── Rows with joined titles ───────────────────────────────────────────────

/** A column of another table that a query joined in under its own name. */
interface Join {
  field: string;
  table: string;
  column: string;
  idField: string;
}

const PROJECT_TITLE: Join = { field: 'project_title', table: 'projects', column: 'title', idField: 'project_id' };
const CALENDAR_NAME: Join = { field: 'calendar_name', table: 'calendars', column: 'name', idField: 'calendar_id' };
const ACCOUNT_NAME: Join = { field: 'account_name', table: 'accounts', column: 'name', idField: 'account_id' };
const TO_ACCOUNT_NAME: Join = { field: 'to_account_name', table: 'accounts', column: 'name', idField: 'to_account_id' };
const CATEGORY_NAME: Join = { field: 'category_name', table: 'categories', column: 'name', idField: 'category_id' };
const RULE_WORDS: Join[] = ['title', 'note', 'place'].map((column) => ({
  field: `recurring_${column}`,
  table: 'recurring_transactions',
  column,
  idField: 'recurring_id',
}));
const TRANSACTION_JOINS = [ACCOUNT_NAME, TO_ACCOUNT_NAME, CATEGORY_NAME, ...RULE_WORDS];

/*
  A transaction made from an encrypted rule carries no words of its own —
  the rule's ciphertext is bound to the rule's id — so the server joins
  the rule's fields and the browser reads them as the transaction's (#219).
*/
async function openTransaction(row: Row): Promise<Row> {
  const out = await openRow('transactions', row, TRANSACTION_JOINS);
  if (out['note'] == null && typeof out['recurring_note'] === 'string') out['note'] = out['recurring_note'];
  if (out['place'] == null && typeof out['recurring_place'] === 'string') out['place'] = out['recurring_place'];
  return out;
}

/** Open a row's own sealed columns and the joined ones, and note plaintext for the job. */
async function openRow(table: string, row: Row, joins: Join[] = [], idField = 'id'): Promise<Row> {
  const id = String(row[idField]);
  const columns = F[table]!;
  markPlaintext(table, id, row[columns[0]!]);
  let out = await openFields(table, id, row, columns);
  for (const join of joins) {
    const joinedId = out[join.idField];
    if (typeof out[join.field] !== 'string' || typeof joinedId !== 'string') continue;
    const opened = await openFields(join.table, joinedId, { [join.column]: out[join.field] }, [join.column]);
    out = { ...out, [join.field]: opened[join.column] };
  }
  return out;
}

const openList = (table: string, rows: Row[], joins: Join[] = [], idField = 'id') =>
  Promise.all(rows.map((row) => openRow(table, row, joins, idField)));

// An occurrence is one date of an event: its id is `<event>#<date>`, its
// ciphertext is the event's, bound to event_id
const openOccurrences = (rows: Row[]) => openList('events', rows, [CALENDAR_NAME, PROJECT_TITLE], 'event_id');

/** Rows of a table with no sealed columns of its own, carrying joined sealed names. */
async function openJoined(rows: Row[], joins: Join[]): Promise<Row[]> {
  return Promise.all(
    rows.map(async (row) => {
      let out = row;
      for (const join of joins) {
        const joinedId = out[join.idField];
        if (typeof out[join.field] !== 'string' || typeof joinedId !== 'string') continue;
        const opened = await openFields(join.table, joinedId, { [join.column]: out[join.field] }, [join.column]);
        out = { ...out, [join.field]: opened[join.column] };
      }
      return out;
    }),
  );
}

/** Seal a create body: mint the id, seal the table's columns under it. */
async function sealCreate(table: string, b: Body): Promise<Body> {
  const id = typeof b['id'] === 'string' ? b['id'] : crypto.randomUUID();
  return sealFields(table, id, { ...b, id }, F[table]!);
}

// ── The table ─────────────────────────────────────────────────────────────

/** The API client, handed in so the codec can issue the odd follow-up request. */
export type Requester = (path: string, method: string, body?: unknown) => Promise<unknown>;

export async function encodeRequest(method: string, path: string, body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = body as Body;
  let m: RegExpMatchArray | null;

  // Notes
  if (method === 'POST' && NOTES_LIST.test(path)) {
    const id = typeof b['id'] === 'string' ? b['id'] : crypto.randomUUID();
    return sealNoteBody(id, { ...b, id });
  }
  if (method === 'PATCH' && (m = path.match(NOTE))) {
    return sealNoteBody(m[1]!, b);
  }
  if (method === 'PATCH' && (m = path.match(NOTE_VERSION))) {
    // A version shares the note's binding — it is the note's own ciphertext, kept
    return sealFields('notes', m[1]!, b, F['note_versions']!);
  }

  // Tasks and projects (#217)
  if (method === 'POST' && TASKS_LIST.test(path)) return sealCreate('tasks', b);
  if (method === 'PATCH' && (m = path.match(TASK))) return sealFields('tasks', m[1]!, b, F['tasks']!);
  if (method === 'POST' && PROJECTS_LIST.test(path)) return sealCreate('projects', b);
  if (method === 'PATCH' && (m = path.match(PROJECT))) return sealFields('projects', m[1]!, b, F['projects']!);

  // Events and calendars (#218)
  if (method === 'POST' && EVENTS_LIST.test(path)) return sealCreate('events', b);
  if (method === 'PATCH' && (m = path.match(EVENT))) return sealFields('events', m[1]!, b, F['events']!);
  if (method === 'POST' && CALENDARS_LIST.test(path)) return sealCreate('calendars', b);
  if (method === 'PATCH' && (m = path.match(CALENDAR))) return sealFields('calendars', m[1]!, b, F['calendars']!);

  // Money (#219)
  if (method === 'POST' && ACCOUNTS_LIST.test(path)) return sealCreate('accounts', b);
  if (method === 'PATCH' && (m = path.match(ACCOUNT))) return sealFields('accounts', m[1]!, b, F['accounts']!);
  if (method === 'POST' && (m = path.match(RECONCILE))) {
    // Never read back; bound to the row's natural key all the same
    return sealFields('reconciliations', `${m[1]!}@${String(b['checked_on'])}`, b, F['reconciliations']!);
  }
  if (method === 'POST' && CATEGORIES_LIST.test(path)) return sealCreate('categories', b);
  if (method === 'PATCH' && (m = path.match(CATEGORY))) return sealFields('categories', m[1]!, b, F['categories']!);
  if (method === 'POST' && TRANSACTIONS_LIST.test(path)) return sealCreate('transactions', b);
  if (method === 'PATCH' && (m = path.match(TRANSACTION))) return sealFields('transactions', m[1]!, b, F['transactions']!);
  if (method === 'POST' && RECURRING_LIST.test(path)) return sealCreate('recurring_transactions', b);
  if (method === 'PATCH' && (m = path.match(RECURRING))) {
    return sealFields('recurring_transactions', m[1]!, b, F['recurring_transactions']!);
  }

  // Lists (#220)
  if (method === 'POST' && LISTS_LIST.test(path)) return sealCreate('lists', b);
  if (method === 'PATCH' && (m = path.match(LIST))) return sealFields('lists', m[1]!, b, F['lists']!);
  if (method === 'POST' && LIST_ITEMS.test(path)) return sealCreate('list_items', b);
  if (method === 'PATCH' && (m = path.match(LIST_ITEM))) return sealFields('list_items', m[1]!, b, F['list_items']!);
  if (method === 'POST' && LIST_SECTIONS.test(path)) return sealCreate('list_sections', b);
  if (method === 'PATCH' && (m = path.match(LIST_SECTION))) return sealFields('list_sections', m[1]!, b, F['list_sections']!);

  // Profile entries (#221)
  if (method === 'POST' && PROFILE_ENTRIES.test(path)) return sealCreate('profile_entries', b);
  if (method === 'PATCH' && (m = path.match(PROFILE_ENTRY))) return sealFields('profile_entries', m[2]!, b, F['profile_entries']!);

  return body;
}

/*
  Closing an encrypted recurring task: the server cannot copy a title bound
  to one task id into another, so it answers `next_due` and the browser
  creates the next occurrence — the same fields, re-sealed under a fresh
  id — and hands the page the `spawned` row it always expected.
*/
async function spawnNext(task: Row, nextDue: string, request: Requester): Promise<Row> {
  return (await request('/tasks', 'POST', {
    project_id: task['project_id'],
    parent_id: task['parent_id'] ?? null,
    title: task['title'],
    description: task['description'] ?? null,
    priority: task['priority'],
    due_date: nextDue,
    assignee_id: task['assignee_id'] ?? null,
    recurrence_rule: task['recurrence_rule'],
    recurrence_parent_id: task['recurrence_parent_id'] ?? task['id'],
  })) as Row;
}

export async function decodeResponse(
  method: string,
  path: string,
  data: unknown,
  request?: Requester,
): Promise<unknown> {
  if (data === null || typeof data !== 'object') return data;
  let m: RegExpMatchArray | null;

  // Notes
  if (method === 'GET' && NOTES_LIST.test(path) && Array.isArray(data)) return openNoteList(data as Row[]);
  if (
    (method === 'GET' && (NOTE.test(path) || NOTE_DAILY.test(path))) ||
    (method === 'PATCH' && NOTE.test(path)) ||
    (method === 'POST' && (NOTES_LIST.test(path) || NOTE_RESTORE.test(path)))
  ) {
    return openNote(data as Row);
  }
  if (method === 'GET' && (m = path.match(NOTE_VERSIONS)) && Array.isArray(data)) {
    const noteId = m[1]!;
    // Keys are `noteId/versionId`: the job needs both to reach a version
    for (const v of data as Row[]) {
      if (typeof v['id'] === 'string') markPlaintext('note_versions', `${noteId}/${v['id']}`, v['title']);
    }
    return openRows('notes', data as Row[], ['title'], () => noteId);
  }
  if (method === 'GET' && (m = path.match(NOTE_VERSION))) {
    return openFields('notes', m[1]!, data as Row, F['note_versions']!);
  }

  // Tasks and projects
  if (method === 'GET' && TASKS_LIST.test(path) && Array.isArray(data)) {
    return openList('tasks', data as Row[], [PROJECT_TITLE]);
  }
  if ((method === 'GET' && TASK.test(path)) || (method === 'POST' && TASKS_LIST.test(path))) {
    return openRow('tasks', data as Row, [PROJECT_TITLE]);
  }
  if (method === 'PATCH' && TASK.test(path)) {
    const d = data as Row;
    if (d['task']) d['task'] = await openRow('tasks', d['task'] as Row);
    if (d['spawned']) d['spawned'] = await openRow('tasks', d['spawned'] as Row);
    if (typeof d['next_due'] === 'string' && d['task'] && request) {
      d['spawned'] = await spawnNext(d['task'] as Row, d['next_due'], request);
    }
    return d;
  }
  if (method === 'GET' && PROJECTS_LIST.test(path) && Array.isArray(data)) return openList('projects', data as Row[]);
  if ((method === 'POST' && PROJECTS_LIST.test(path)) || (method === 'PATCH' && PROJECT.test(path))) {
    return openRow('projects', data as Row);
  }

  // Events and calendars
  if (method === 'GET' && EVENTS_LIST.test(path) && Array.isArray(data)) return openOccurrences(data as Row[]);
  if ((method === 'GET' && EVENT.test(path)) || (method === 'POST' && EVENTS_LIST.test(path)) || (method === 'PATCH' && EVENT.test(path))) {
    return openRow('events', data as Row);
  }
  if (method === 'GET' && CALENDARS_LIST.test(path) && Array.isArray(data)) return openList('calendars', data as Row[]);
  if ((method === 'POST' && CALENDARS_LIST.test(path)) || (method === 'PATCH' && CALENDAR.test(path))) {
    return openRow('calendars', data as Row);
  }

  // Money
  if (method === 'GET' && ACCOUNTS_LIST.test(path) && Array.isArray(data)) return openList('accounts', data as Row[]);
  if ((method === 'POST' && ACCOUNTS_LIST.test(path)) || (method === 'PATCH' && ACCOUNT.test(path))) {
    return openRow('accounts', data as Row);
  }
  if (method === 'GET' && CATEGORIES_LIST.test(path) && Array.isArray(data)) return openList('categories', data as Row[]);
  if ((method === 'POST' && CATEGORIES_LIST.test(path)) || (method === 'PATCH' && CATEGORY.test(path))) {
    return openRow('categories', data as Row);
  }
  if (method === 'GET' && TRANSACTIONS_LIST.test(path) && Array.isArray(data)) {
    return Promise.all((data as Row[]).map(openTransaction));
  }
  if (
    (method === 'POST' && TRANSACTIONS_LIST.test(path)) ||
    (method === 'PATCH' && TRANSACTION.test(path)) ||
    (method === 'POST' && RECURRING_CONFIRM.test(path))
  ) {
    return openRow('transactions', data as Row);
  }
  if (method === 'GET' && RECURRING_LIST.test(path) && Array.isArray(data)) {
    return openList('recurring_transactions', data as Row[], [ACCOUNT_NAME, CATEGORY_NAME]);
  }
  if ((method === 'POST' && RECURRING_LIST.test(path)) || (method === 'PATCH' && RECURRING.test(path))) {
    return openRow('recurring_transactions', data as Row);
  }
  if (method === 'GET' && path === '/recurring/due' && Array.isArray(data)) {
    // A due item is one date of a rule: its title is the rule's, bound to recurring_id
    return openList('recurring_transactions', data as Row[], [ACCOUNT_NAME, CATEGORY_NAME], 'recurring_id');
  }
  // Lists
  if (method === 'GET' && LISTS_LIST.test(path) && Array.isArray(data)) return openList('lists', data as Row[]);
  if ((method === 'POST' && LISTS_LIST.test(path)) || (method === 'PATCH' && LIST.test(path))) {
    return openRow('lists', data as Row);
  }
  if (method === 'GET' && LIST.test(path)) {
    const d = await openRow('lists', data as Row);
    if (Array.isArray(d['items'])) d['items'] = await openList('list_items', d['items'] as Row[]);
    if (Array.isArray(d['sections'])) d['sections'] = await openList('list_sections', d['sections'] as Row[]);
    return d;
  }
  if ((method === 'POST' && (LIST_ITEMS.test(path) || LIST_ITEM_ANY.test(path))) || (method === 'PATCH' && LIST_ITEM_ANY.test(path))) {
    return openRow('list_items', data as Row);
  }
  if ((method === 'POST' && LIST_SECTIONS.test(path)) || (method === 'PATCH' && LIST_SECTION.test(path))) {
    return openRow('list_sections', data as Row);
  }

  // Attachments (#222): the filename is words, the file is opened by lib/files.ts
  if (method === 'GET' && TRANSACTION_ATTACHMENTS.test(path) && Array.isArray(data)) {
    return openList('attachments', data as Row[]);
  }
  if (method === 'GET' && MAIL_MESSAGE.test(path)) {
    const d = data as Row;
    if (Array.isArray(d['attachments'])) d['attachments'] = await openList('attachments', d['attachments'] as Row[]);
    return d;
  }

  // Profiles
  if (method === 'GET' && PROFILES_LIST.test(path) && Array.isArray(data)) {
    return Promise.all(
      (data as Row[]).map(async (member) =>
        Array.isArray(member['allergies'])
          ? { ...member, allergies: await openList('profile_entries', member['allergies'] as Row[]) }
          : member,
      ),
    );
  }
  if (method === 'GET' && PROFILE.test(path)) {
    const d = data as Row;
    if (Array.isArray(d['entries'])) d['entries'] = await openList('profile_entries', d['entries'] as Row[]);
    return d;
  }
  if ((method === 'POST' && PROFILE_ENTRIES.test(path)) || (method === 'PATCH' && PROFILE_ENTRY.test(path))) {
    return openRow('profile_entries', data as Row);
  }

  if (method === 'GET' && path.startsWith('/budgets') && Array.isArray(data)) {
    return openJoined(data as Row[], [CATEGORY_NAME]);
  }
  if (method === 'GET' && path.startsWith('/money/summary')) {
    const d = data as Row;
    if (Array.isArray(d['byCategory'])) d['byCategory'] = await openJoined(d['byCategory'] as Row[], [CATEGORY_NAME]);
    return d;
  }
  if (method === 'GET' && path.startsWith('/money/outlook')) {
    const d = data as Row;
    const ruleTitle: Join = { field: 'title', table: 'recurring_transactions', column: 'title', idField: 'recurring_id' };
    for (const currency of (d['currencies'] as Row[]) ?? []) {
      if (Array.isArray(currency['bills'])) currency['bills'] = await openJoined(currency['bills'] as Row[], [ruleTitle]);
      if (currency['next_income']) currency['next_income'] = (await openJoined([currency['next_income'] as Row], [ruleTitle]))[0];
    }
    return d;
  }

  // Aggregates
  if (method === 'GET' && path.startsWith('/dashboard')) {
    const d = data as Row;
    if (Array.isArray(d['recentNotes'])) {
      d['recentNotes'] = await openRows('notes', d['recentNotes'] as Row[], ['title']);
      for (const n of d['recentNotes'] as Row[]) rememberNote(n);
    }
    for (const bucket of ['dueToday', 'overdue', 'upcoming']) {
      if (Array.isArray(d[bucket])) d[bucket] = await openList('tasks', d[bucket] as Row[], [PROJECT_TITLE]);
    }
    if (Array.isArray(d['todayEvents'])) d['todayEvents'] = await openOccurrences(d['todayEvents'] as Row[]);
    if (Array.isArray(d['reminders'])) d['reminders'] = await openOccurrences(d['reminders'] as Row[]);
    return d;
  }
  if (method === 'GET' && path.startsWith('/search/corpus')) {
    const d = data as Row;
    if (Array.isArray(d['notes'])) d['notes'] = await openNoteList(d['notes'] as Row[]);
    if (Array.isArray(d['tasks'])) d['tasks'] = await openList('tasks', d['tasks'] as Row[], [PROJECT_TITLE]);
    if (Array.isArray(d['projects'])) d['projects'] = await openList('projects', d['projects'] as Row[]);
    if (Array.isArray(d['events'])) d['events'] = await openList('events', d['events'] as Row[], [CALENDAR_NAME]);
    if (Array.isArray(d['attachments'])) d['attachments'] = await openList('attachments', d['attachments'] as Row[]);
    return d;
  }
  return data;
}

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
  return opened;
}

async function openNoteList(rows: Row[]): Promise<Row[]> {
  const opened = await Promise.all(rows.map((row) => openNote(row)));
  return opened;
}

// ── The table ─────────────────────────────────────────────────────────────

export async function encodeRequest(method: string, path: string, body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const b = body as Body;
  let m: RegExpMatchArray | null;

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
  return body;
}

export async function decodeResponse(method: string, path: string, data: unknown): Promise<unknown> {
  if (data === null || typeof data !== 'object') return data;
  let m: RegExpMatchArray | null;

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
  if (method === 'GET' && path.startsWith('/dashboard')) {
    const d = data as Row;
    if (Array.isArray(d['recentNotes'])) {
      d['recentNotes'] = await openRows('notes', d['recentNotes'] as Row[], ['title']);
      for (const n of d['recentNotes'] as Row[]) rememberNote(n);
    }
    return d;
  }
  if (method === 'GET' && path.startsWith('/search/corpus')) {
    const d = data as Row;
    if (Array.isArray(d['notes'])) d['notes'] = await openNoteList(d['notes'] as Row[]);
    return d;
  }
  return data;
}

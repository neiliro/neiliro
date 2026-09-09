import { api } from './api';
import { t } from './i18n';

/*
  Global search, in the browser (#216).

  The server cannot match a query against words it cannot read, so it
  hands over the searchable rows it lets this person see (/api/search/corpus
  — owner_id and calendar sharing applied there, exactly as before) and the
  matching happens here, on decrypted text. Substring, case-insensitive:
  the same "morphology for free" the trigram index gave — «переезд» finds
  «переезда» — Cyrillic included, three characters minimum as before.

  A family's corpus is thousands of rows, fetched once and kept for a short
  while; a write in this tab invalidates it. No sync engine.
*/

export interface SearchResult {
  kind: 'task' | 'note' | 'event' | 'project' | 'attachment';
  id: string;
  title: string;
  subtitle: string;
  project_id?: string;
  excerpt: string;
  color: string | null;
  badge: string | null;
  url: string;
}

interface Corpus {
  notes: { id: string; title: string; body_md: string; visibility: string; is_template: number; folder_name: string | null }[];
  tasks: { id: string; title: string; description: string | null; status: string; due_date: string | null; project_id: string; project_title: string; color: string }[];
  projects: { id: string; title: string; description: string | null; color: string }[];
  events: { id: string; title: string; description: string | null; location: string | null; starts_at: string; calendar_name: string; color: string }[];
  attachments: { id: string; filename: string; size_bytes: number; note_id: string | null; note_title: string | null }[];
}

const CORPUS_TTL_MS = 30_000;
let cached: { at: number; corpus: Corpus } | null = null;

export function invalidateSearchCorpus(): void {
  cached = null;
}

async function corpus(): Promise<Corpus> {
  if (cached && Date.now() - cached.at < CORPUS_TTL_MS) return cached.corpus;
  const fresh = await api.get<Corpus>('/search/corpus');
  cached = { at: Date.now(), corpus: fresh };
  return fresh;
}

const has = (text: string | null | undefined, q: string): boolean =>
  typeof text === 'string' && text.toLowerCase().includes(q);

/** A window of text around the first match, the way the FTS snippet read. */
function snippet(text: string | null | undefined, q: string): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ');
  const at = flat.toLowerCase().indexOf(q);
  if (at < 0) return '';
  const from = Math.max(0, at - 40);
  const to = Math.min(flat.length, at + q.length + 60);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '…' : ''}`;
}

export async function search(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const c = await corpus();
  const results: SearchResult[] = [];

  for (const t of c.tasks) {
    if (has(t.title, q) || has(t.description, q)) {
      results.push({
        kind: 'task', id: t.id, title: t.title, subtitle: t.project_title, project_id: t.project_id,
        excerpt: has(t.title, q) ? '' : snippet(t.description, q), color: t.color, badge: t.due_date, url: `/tasks?open=${t.id}`,
      });
    }
  }
  for (const n of c.notes) {
    if (n.is_template) continue;
    if (has(n.title, q) || has(n.body_md, q)) {
      results.push({
        kind: 'note', id: n.id, title: n.title,
        subtitle: n.folder_name ?? (n.visibility === 'private' ? t('Private') : t('No folder')),
        excerpt: snippet(n.body_md, q), color: null, badge: null, url: `/notes?open=${n.id}`,
      });
    }
  }
  for (const e of c.events) {
    if (has(e.title, q) || has(e.description, q) || has(e.location, q)) {
      results.push({
        kind: 'event', id: e.id, title: e.title, subtitle: e.location ?? e.calendar_name,
        excerpt: '', color: e.color, badge: e.starts_at.slice(0, 10), url: `/calendar?date=${e.starts_at.slice(0, 10)}`,
      });
    }
  }
  for (const p of c.projects) {
    if (has(p.title, q) || has(p.description, q)) {
      results.push({
        kind: 'project', id: p.id, title: p.title, subtitle: t('Project'),
        excerpt: has(p.title, q) ? '' : snippet(p.description, q), color: p.color, badge: null, url: `/tasks?project=${p.id}`,
      });
    }
  }
  for (const a of c.attachments) {
    if (has(a.filename, q)) {
      results.push({
        kind: 'attachment', id: a.id, title: a.filename, subtitle: a.note_title ?? t('File'),
        excerpt: '', color: null, badge: null, url: a.note_id ? `/notes?open=${a.note_id}` : `/api/attachments/${a.id}`,
      });
    }
  }
  // Like the server did: a cap, and tasks/notes/events/projects/attachments in that order
  return results.slice(0, 60);
}

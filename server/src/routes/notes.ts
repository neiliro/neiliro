import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentTenant, db, id, now, today } from '../db/index.js';

interface NoteRow {
  id: string;
  title: string;
  body_md: string;
  folder_id: string | null;
  visibility: 'shared' | 'private';
  owner_id: string | null;
  is_template: number;
  daily_date: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

/**
 * A private note is visible to its owner only.
 * Role plays no part here: the admin is a service account for managing
 * the system, not a superuser over content. See the roles section of the spec.
 */
const VISIBLE = "(n.visibility = 'shared' OR n.owner_id = ?)";

/**
 * Note preview for the list: markdown syntax is stripped, text remains.
 * A real markdown parser is overkill here — the preview lives on a single
 * line; it is enough to remove what catches the eye: images, links,
 * wiki-links, list markers and inline markers.
 */
export function excerptOf(body: string): string {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images — whole
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[wiki-link]] → its title
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [link](url) → text
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/gm, '') // list markers and checkboxes
    .replace(/^\s*#{1,6}\s+/gm, '') // headings
    .replace(/^\s*>\s?/gm, '') // quotes
    .replace(/[*_`~]/g, '') // bold/italic/code/strikethrough
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function loadVisible(noteId: string, userId: string): NoteRow | null {
  const row = db
    .prepare(`SELECT n.* FROM notes n WHERE n.id = ? AND ${VISIBLE}`)
    .get(noteId, userId) as NoteRow | undefined;
  return row ?? null;
}

/** Any family member may edit a note, except other people's private ones. */
function guard(
  noteId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): NoteRow | null {
  const note = loadVisible(noteId, req.user?.id ?? '');
  if (!note) {
    reply.code(404).send({ error: 'Note not found' });
    return null;
  }
  return note;
}

// ── [[Title]] links ───────────────────────────────────────────────────────

const WIKI_LINK = /\[\[([^\][|]{1,200})\]\]/g;
const ESCAPED_WIKI_LINK = /\\\[\\\[([^\][|]{1,200})\\\]\\\]/g;

/**
 * Markdown editors love escaping square brackets. Links are normalized to
 * canonical form before the text reaches the database: otherwise the note
 * reads fine to the eye while the connection between notes is lost.
 */
export function normalizeWikiLinks(body: string): string {
  return body.replace(ESCAPED_WIKI_LINK, '[[$1]]');
}

export function extractLinks(body: string): string[] {
  const titles = new Set<string>();
  for (const match of body.matchAll(WIKI_LINK)) {
    const title = match[1]?.trim();
    if (title) titles.add(title);
  }
  return [...titles];
}

/**
 * Rebuilds a note's outgoing links.
 * A link to a not-yet-created note is stored with an empty target — when
 * a note with that title appears, the connection picks up automatically.
 */
function rebuildLinks(noteId: string, body: string): void {
  db.prepare('DELETE FROM note_links WHERE source_note_id = ?').run(noteId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO note_links (source_note_id, target_note_id, target_title)
     VALUES (?, (SELECT id FROM notes WHERE lower(title) = lower(?) LIMIT 1), ?)`,
  );
  for (const title of extractLinks(body)) insert.run(noteId, title, title);
}

/** Picks up dangling links pointing at a note with this title. */
function resolveIncoming(noteId: string, title: string): void {
  db.prepare(
    `UPDATE note_links SET target_note_id = ?
      WHERE target_note_id IS NULL AND lower(target_title) = lower(?)`,
  ).run(noteId, title);
}

/**
 * The client names the locale for {{date}}/{{time}} (it is the only side
 * that knows the interface language); anything absent or unformattable
 * falls back to English — the source language, and what a self-hoster who
 * never chose Russian must get. Intl throws RangeError on a malformed tag
 * rather than falling back, hence the probe.
 */
function resolveLocale(locale: string | undefined): string {
  if (!locale) return 'en-GB';
  try {
    new Intl.DateTimeFormat(locale);
    return locale;
  } catch {
    return 'en-GB';
  }
}

/**
 * Template placeholders. Expanded once, at note creation: after that it
 * is plain editable text. Live, recomputed values are deliberately absent
 * here — a note must mean the same thing a year later.
 *
 * The Russian placeholder KEYS ({{дата}}, {{время}}, {{автор}}) are
 * backwards compatibility for pre-English-first templates and stay; only
 * the output locale follows the request (#47).
 */
export function applyPlaceholders(text: string, authorName: string, locale?: string): string {
  const date = new Date();
  const tag = resolveLocale(locale);
  const longDate = new Intl.DateTimeFormat(tag, { dateStyle: 'long' }).format(date);
  const shortTime = new Intl.DateTimeFormat(tag, { timeStyle: 'short' }).format(date);
  const values: Record<string, string> = {
    дата: longDate,
    date: longDate,
    // By the local clock, like the date and time placeholders: toISOString()
    // would give the Greenwich date, and a note created at 00:30 would be
    // stamped with yesterday
    изо: today(),
    iso: today(),
    время: shortTime,
    time: shortTime,
    автор: authorName,
    author: authorName,
  };

  return text.replace(/\{\{\s*([\wа-яёА-ЯЁ_]+)\s*\}\}/gu, (match, rawKey: string) => {
    const key = rawKey.toLowerCase();
    return values[key] ?? match;
  });
}

// ── Version history ───────────────────────────────────────────────────────

const VERSION_GAP_MINUTES = 10;

/**
 * A snapshot of the previous content — but not on every save.
 * Autosave fires every couple of seconds, and without this condition one
 * evening of work would turn the history into a thousand useless rows.
 */
function snapshotIfNeeded(note: NoteRow, authorId: string): void {
  const last = db
    .prepare(
      `SELECT author_id, created_at FROM note_versions
        WHERE note_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(note.id) as { author_id: string | null; created_at: string } | undefined;

  const stale =
    !last ||
    last.author_id !== authorId ||
    Date.now() - new Date(`${last.created_at.replace(' ', 'T')}Z`).getTime() >
      VERSION_GAP_MINUTES * 60_000;

  if (!stale) return;

  db.prepare(
    `INSERT INTO note_versions (id, note_id, title, body_md, author_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id(), note.id, note.title, note.body_md, authorId, now());
}

// ── Schemas ───────────────────────────────────────────────────────────────

const createInput = z.object({
  title: z.string().max(200).optional(),
  body_md: z.string().max(500_000).optional(),
  folder_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(['shared', 'private']).optional(),
  template_id: z.string().uuid().optional(),
  // BCP-47-ish tag for {{date}}/{{time}} expansion; validated leniently,
  // resolveLocale() probes the rest
  locale: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).optional(),
  is_template: z.boolean().optional(),
  daily_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const patchInput = z.object({
  title: z.string().min(1, 'The note needs a title').max(200).optional(),
  body_md: z.string().max(500_000).optional(),
  folder_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(['shared', 'private']).optional(),
  pinned: z.boolean().optional(),
  is_template: z.boolean().optional(),
});

export async function registerNoteRoutes(app: FastifyInstance): Promise<void> {
  // ── Folders ─────────────────────────────────────────────────────────────

  app.get('/api/folders', () =>
    db.prepare('SELECT * FROM folders ORDER BY position, name').all(),
  );

  app.post('/api/folders', (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1, 'Enter a folder name').max(100),
        parent_id: z.string().uuid().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const folderId = id();
    db.prepare(
      `INSERT INTO folders (id, parent_id, name, position)
       VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM folders))`,
    ).run(folderId, parsed.data.parent_id ?? null, parsed.data.name.trim());
    return reply.code(201).send(db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId));
  });

  app.patch('/api/folders/:id', (req, reply) => {
    const { id: folderId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = z.object({ name: z.string().min(1).max(100) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a folder name' });

    const result = db
      .prepare('UPDATE folders SET name = ? WHERE id = ?')
      .run(parsed.data.name.trim(), folderId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Folder not found' });
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
  });

  app.delete('/api/folders/:id', (req, reply) => {
    const { id: folderId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const count = (
      db.prepare('SELECT count(*) AS n FROM notes WHERE folder_id = ?').get(folderId) as {
        n: number;
      }
    ).n;
    if (count > 0) {
      return reply
        .code(409)
        .send({
          error:
            `The folder has ${count} ${count === 1 ? 'note' : 'notes'}. ` +
            'Move its contents elsewhere first',
        });
    }
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    return { ok: true };
  });

  // ── Note list ───────────────────────────────────────────────────────────

  app.get('/api/notes', (req) => {
    const q = z
      .object({
        folder_id: z.string().optional(),
        templates: z.enum(['true', 'false']).optional(),
        q: z.string().max(200).optional(),
      })
      .parse(req.query);

    const userId = req.user?.id ?? '';
    const where = [VISIBLE, 'n.is_template = ?'];
    const args: unknown[] = [userId, q.templates === 'true' ? 1 : 0];

    if (q.folder_id === 'none') {
      where.push('n.folder_id IS NULL');
    } else if (q.folder_id) {
      where.push('n.folder_id = ?');
      args.push(q.folder_id);
    }
    if (q.q) {
      where.push('(ci_contains(n.title, ?) OR ci_contains(n.body_md, ?))');
      args.push(q.q, q.q);
    }

    const rows = db
      .prepare(
        `SELECT n.id, n.title, n.folder_id, n.visibility, n.owner_id, n.pinned,
                n.daily_date, n.is_template, n.updated_at, u.name AS owner_name,
                substr(n.body_md, 1, 400) AS excerpt
           FROM notes n
           LEFT JOIN users u ON u.id = n.owner_id
          WHERE ${where.join(' AND ')}
          ORDER BY n.pinned DESC, n.updated_at DESC`,
      )
      .all(...args) as Record<string, unknown>[];

    // The preview is cleaned here, not in SQL: the query used to cut raw
    // markdown, and the list showed **asterisks** and [[brackets]]
    return rows.map((r) => ({ ...r, excerpt: excerptOf(String(r.excerpt ?? '')) }));
  });

  // ── One note with its connections ───────────────────────────────────────

  app.get('/api/notes/:id', (req, reply) => {
    const { id: noteId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const note = guard(noteId, req, reply);
    if (!note) return;

    const userId = req.user?.id ?? '';

    const outgoing = db
      .prepare(
        `SELECT l.target_title, l.target_note_id,
                CASE WHEN n.id IS NULL THEN 0 ELSE 1 END AS exists_now
           FROM note_links l
           LEFT JOIN notes n ON n.id = l.target_note_id
            AND (n.visibility = 'shared' OR n.owner_id = ?)
          WHERE l.source_note_id = ?
          ORDER BY l.target_title`,
      )
      .all(userId, noteId);

    const backlinks = db
      .prepare(
        `SELECT n.id, n.title FROM note_links l
           JOIN notes n ON n.id = l.source_note_id
          WHERE l.target_note_id = ? AND (n.visibility = 'shared' OR n.owner_id = ?)
          ORDER BY n.title`,
      )
      .all(noteId, userId);

    const attachments = db
      .prepare(
        `SELECT id, filename, mime, size_bytes, created_at,
                CASE WHEN mime LIKE 'image/%' THEN 1 ELSE 0 END AS is_image
           FROM attachments
          WHERE note_id = ?
          ORDER BY created_at`,
      )
      .all(noteId);

    return { ...note, outgoing, backlinks, attachments };
  });

  // ── Creation ────────────────────────────────────────────────────────────

  app.post('/api/notes', (req, reply) => {
    const parsed = createInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;
    const userId = req.user?.id ?? null;

    const authorName =
      (
        db.prepare('SELECT name FROM users WHERE id = ?').get(userId ?? '') as
          | { name: string }
          | undefined
      )?.name ?? '';

    let body = normalizeWikiLinks(d.body_md ?? '');
    let titleFromTemplate: string | null = null;
    let inheritedVisibility: 'private' | null = null;

    if (d.template_id) {
      // A template obeys the same visibility as a regular note: someone
      // else's private template can't be expanded even knowing its id
      const template = db
        .prepare(
          `SELECT title, body_md, visibility FROM notes
            WHERE id = ? AND is_template = 1
              AND (visibility = 'shared' OR owner_id = ?)`,
        )
        .get(d.template_id, userId ?? '') as
        | { title: string; body_md: string; visibility: 'shared' | 'private' }
        | undefined;
      if (!template) return reply.code(400).send({ error: 'Template not found' });
      body = applyPlaceholders(template.body_md, authorName, d.locale);
      titleFromTemplate = applyPlaceholders(template.title, authorName, d.locale);
      // A template is private because its CONTENT is private — a journal
      // structure, a medical log. Expanding it must not silently publish
      // that content to the family: without an explicit choice in the
      // request, the note inherits the template's visibility. (#50)
      if (d.visibility === undefined && template.visibility === 'private') {
        inheritedVisibility = 'private';
      }
    }

    if (d.daily_date) {
      const existing = db.prepare('SELECT * FROM notes WHERE daily_date = ?').get(d.daily_date) as
        | NoteRow
        | undefined;
      if (existing) {
        // Someone else's private daily note is not returned — same as in
        // GET /api/notes/daily. A second one for the same date can't be
        // created (daily_date is unique), hence 409.
        if (existing.visibility === 'private' && existing.owner_id !== userId) {
          return reply
            .code(409)
            .send({ error: 'A note for this date already exists, and it is private' });
        }
        return reply.code(200).send(existing);
      }
    }

    const noteId = id();
    const title =
      d.title?.trim() || titleFromTemplate || d.daily_date || 'Untitled';

    db.prepare(
      `INSERT INTO notes (id, title, body_md, folder_id, visibility, owner_id, daily_date,
                          is_template, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      noteId,
      title,
      body,
      d.folder_id ?? null,
      d.visibility ?? inheritedVisibility ?? 'shared',
      userId,
      d.daily_date ?? null,
      d.is_template ? 1 : 0,
      now(),
      now(),
    );

    rebuildLinks(noteId, body);
    resolveIncoming(noteId, title);

    return reply.code(201).send(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId));
  });

  // ── Editing ─────────────────────────────────────────────────────────────

  app.patch('/api/notes/:id', (req, reply) => {
    const { id: noteId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const note = guard(noteId, req, reply);
    if (!note) return;

    const parsed = patchInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;
    const userId = req.user?.id ?? '';

    // Only the person who would become its owner may make a note private
    if (d.visibility === 'private' && note.owner_id && note.owner_id !== userId) {
      return reply.code(403).send({ error: 'Only the owner can make a note private' });
    }

    const contentChanged =
      (d.title !== undefined && d.title !== note.title) ||
      (d.body_md !== undefined && normalizeWikiLinks(d.body_md) !== note.body_md);

    const run = db.transaction(() => {
      if (contentChanged) snapshotIfNeeded(note, userId);

      const fields: [string, unknown][] = [];
      if (d.title !== undefined) fields.push(['title', d.title.trim()]);
      if (d.body_md !== undefined) fields.push(['body_md', normalizeWikiLinks(d.body_md)]);
      if (d.folder_id !== undefined) fields.push(['folder_id', d.folder_id]);
      if (d.pinned !== undefined) fields.push(['pinned', d.pinned ? 1 : 0]);
      if (d.is_template !== undefined) fields.push(['is_template', d.is_template ? 1 : 0]);
      if (d.visibility !== undefined) {
        fields.push(['visibility', d.visibility]);
        // A private note must have an owner, or nobody would see it at all
        if (d.visibility === 'private' && !note.owner_id) fields.push(['owner_id', userId]);
      }

      if (fields.length > 0) {
        const set = fields.map(([k]) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE notes SET ${set}, updated_at = ? WHERE id = ?`).run(
          ...fields.map(([, v]) => v as string | number | null),
          now(),
          noteId,
        );
      }

      if (d.body_md !== undefined) rebuildLinks(noteId, normalizeWikiLinks(d.body_md));
      if (d.title !== undefined) resolveIncoming(noteId, d.title.trim());
    });
    run();

    return db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  });

  app.delete('/api/notes/:id', async (req, reply) => {
    const { id: noteId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const note = guard(noteId, req, reply);
    if (!note) return;

    // Database rows go away via cascade, but files on disk must be removed
    // by hand, or the attachments directory grows forever.
    const files = db
      .prepare('SELECT storage_path FROM attachments WHERE note_id = ?')
      .all(noteId) as { storage_path: string }[];

    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);

    for (const file of files) {
      await unlink(resolve(currentTenant().attachmentsDir, file.storage_path)).catch(() => {});
    }
    return { ok: true };
  });

  // ── History ─────────────────────────────────────────────────────────────

  app.get('/api/notes/:id/versions', (req, reply) => {
    const { id: noteId } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!guard(noteId, req, reply)) return;

    return db
      .prepare(
        `SELECT v.id, v.title, v.created_at, u.name AS author_name,
                length(v.body_md) AS size
           FROM note_versions v
           LEFT JOIN users u ON u.id = v.author_id
          WHERE v.note_id = ?
          ORDER BY v.created_at DESC
          LIMIT 50`,
      )
      .all(noteId);
  });

  app.get('/api/notes/:id/versions/:versionId', (req, reply) => {
    const { id: noteId, versionId } = z
      .object({ id: z.string().uuid(), versionId: z.string().uuid() })
      .parse(req.params);
    if (!guard(noteId, req, reply)) return;

    const version = db
      .prepare('SELECT * FROM note_versions WHERE id = ? AND note_id = ?')
      .get(versionId, noteId);
    if (!version) return reply.code(404).send({ error: 'Version not found' });
    return version;
  });

  app.post('/api/notes/:id/restore/:versionId', (req, reply) => {
    const { id: noteId, versionId } = z
      .object({ id: z.string().uuid(), versionId: z.string().uuid() })
      .parse(req.params);
    const note = guard(noteId, req, reply);
    if (!note) return;

    const version = db
      .prepare('SELECT title, body_md FROM note_versions WHERE id = ? AND note_id = ?')
      .get(versionId, noteId) as { title: string; body_md: string } | undefined;
    if (!version) return reply.code(404).send({ error: 'Version not found' });

    const userId = req.user?.id ?? '';
    const run = db.transaction(() => {
      // The current state is always saved: a rollback must be reversible too
      db.prepare(
        `INSERT INTO note_versions (id, note_id, title, body_md, author_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id(), noteId, note.title, note.body_md, userId, now());

      db.prepare('UPDATE notes SET title = ?, body_md = ?, updated_at = ? WHERE id = ?').run(
        version.title,
        version.body_md,
        now(),
        noteId,
      );
      rebuildLinks(noteId, version.body_md);
    });
    run();

    return db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  });

  // ── Daily note ──────────────────────────────────────────────────────────

  app.get('/api/notes/daily/:date', (req, reply) => {
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(req.params);

    const existing = db.prepare('SELECT * FROM notes WHERE daily_date = ?').get(date) as
      | NoteRow
      | undefined;
    if (existing) {
      if (existing.visibility === 'private' && existing.owner_id !== req.user?.id) {
        return reply.code(404).send({ error: 'Note not found' });
      }
      return existing;
    }
    return reply.code(404).send({ error: 'There is no note for this date yet' });
  });
}

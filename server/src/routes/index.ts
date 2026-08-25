import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now, today as localToday } from '../db/index.js';
import { env } from '../env.js';
import { listOccurrences, remindersFor } from './calendar.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Only the fact of life goes outside. The version and other details are
  // of no use to the public internet: the less a scanner learns for free,
  // the better. The database query is so "alive" means "alive along with
  // the database", not "the process exists": a container with a dead
  // SQLite must not be healthy.
  app.get('/api/health', (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // ── Home name (public — the login page needs it without a session) ────

  app.get('/api/home-name', () => {
    // Hosted: the public answer is always the brand. A family-chosen name
    // is private data, and a renamed family must stay indistinguishable
    // from the ghost (lib/tenants.ts). Inside the app the name arrives
    // through /api/settings, behind the session.
    if (env.hostedMode) return { name: 'Neiliro' };

    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'home.name'")
      .get() as { value: string } | undefined;
    return { name: row?.value?.trim() || 'Neiliro' };
  });

  // ── Settings (dashboard widgets included) ──────────────────────────────

  app.get('/api/settings', () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.patch('/api/settings', (req, reply) => {
    // Keys and values are bounded in shape and length: writes used to be
    // unbounded, and that was the cheapest way to bloat the database from
    // any account. Real settings (dashboard labels, currency) fit with
    // plenty of headroom.
    const parsed = z
      .record(
        z.string().max(64).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid settings key'),
        z.string().max(500),
      )
      .refine((r) => Object.keys(r).length <= 20, 'Too many settings at once')
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Settings must be pairs of strings' });
    }
    // A ceiling on the total key count — the same protection from the other
    // end. Only new keys count: updating existing ones doesn't grow the base.
    const keys = Object.keys(parsed.data);
    if (keys.length === 0) return { ok: true };
    const { n } = db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number };
    const { known } = db
      .prepare(
        `SELECT count(*) AS known FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`,
      )
      .get(...keys) as { known: number };
    if (n - known + keys.length > 200) {
      return reply.code(400).send({ error: 'Too many settings' });
    }
    const stmt = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const write = db.transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) stmt.run(k, v, now());
    });
    write(Object.entries(parsed.data));
    return { ok: true };
  });

  // ── Global search ───────────────────────────────────────────────────────

  /**
   * Searches the whole space: notes, tasks, projects, events, attachments.
   *
   * Notes, tasks and projects go through the FTS5 full-text index —
   * note bodies need searching there, and that can be tens of thousands
   * of characters. Events and attachments are scanned directly with
   * ci_contains: there are few of them, and maintaining index triggers
   * for an entity whose visibility depends on calendar settings is a
   * desync source out of nowhere.
   */
  app.get('/api/search', (req, reply) => {
    const { q } = z.object({ q: z.string() }).parse(req.query);
    const query = q.trim();
    if (query.length < 3) {
      return reply.code(400).send({ error: 'Search needs at least 3 characters' });
    }
    const userId = req.user?.id ?? '';
    const match = `"${query.replace(/"/g, '""')}"`;

    const indexed = db
      .prepare(
        `SELECT entity, entity_id,
                snippet(search_index, 5, '', '', '…', 14) AS excerpt
           FROM search_index
          WHERE search_index MATCH ?
            AND (visibility = 'shared' OR owner_id = ?)
          ORDER BY rank
          LIMIT 60`,
      )
      .all(match, userId) as { entity: string; entity_id: string; excerpt: string }[];

    const byKind = (kind: string) => indexed.filter((r) => r.entity === kind).map((r) => r.entity_id);
    const excerptOf = new Map(indexed.map((r) => [r.entity_id, r.excerpt]));
    const holes = (ids: string[]) => ids.map(() => '?').join(',');

    const noteIds = byKind('note');
    const notes = noteIds.length
      ? (db
          .prepare(
            `SELECT n.id, n.title, f.name AS folder_name, n.visibility
               FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
              WHERE n.id IN (${holes(noteIds)}) AND n.is_template = 0`,
          )
          .all(...noteIds) as { id: string; title: string; folder_name: string | null; visibility: string }[])
      : [];

    const taskIds = byKind('task');
    const tasks = taskIds.length
      ? (db
          .prepare(
            `SELECT t.id, t.title, t.status, t.due_date, t.project_id, p.title AS project_title, p.color
               FROM tasks t JOIN projects p ON p.id = t.project_id
              WHERE t.id IN (${holes(taskIds)})`,
          )
          .all(...taskIds) as {
          id: string;
          title: string;
          status: string;
          due_date: string | null;
          project_id: string;
          project_title: string;
          color: string;
        }[])
      : [];

    const projectIds = byKind('project');
    const projects = projectIds.length
      ? (db
          .prepare(`SELECT id, title, color FROM projects WHERE id IN (${holes(projectIds)})`)
          .all(...projectIds) as { id: string; title: string; color: string }[])
      : [];

    const events = db
      .prepare(
        `SELECT e.id, e.title, e.starts_at, e.location, c.name AS calendar_name, c.color
           FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE (c.shared = 1 OR c.owner_id = ?)
            AND (ci_contains(e.title, ?) OR ci_contains(coalesce(e.description, ''), ?)
                 OR ci_contains(coalesce(e.location, ''), ?))
          ORDER BY e.starts_at DESC
          LIMIT 15`,
      )
      .all(userId, query, query, query) as {
      id: string;
      title: string;
      starts_at: string;
      location: string | null;
      calendar_name: string;
      color: string;
    }[];

    const attachments = db
      .prepare(
        `SELECT a.id, a.filename, a.size_bytes, n.id AS note_id, n.title AS note_title
           FROM attachments a
           LEFT JOIN notes n ON n.id = a.note_id
          WHERE ci_contains(a.filename, ?)
            AND (a.note_id IS NULL OR n.visibility = 'shared' OR n.owner_id = ?)
          LIMIT 15`,
      )
      .all(query, userId) as {
      id: string;
      filename: string;
      size_bytes: number;
      note_id: string | null;
      note_title: string | null;
    }[];

    return {
      query,
      results: [
        ...tasks.map((t) => ({
          kind: 'task' as const,
          id: t.id,
          title: t.title,
          subtitle: t.project_title,
          project_id: t.project_id,
          excerpt: excerptOf.get(t.id) ?? '',
          color: t.color,
          badge: t.due_date,
          url: `/tasks?open=${t.id}`,
        })),
        ...notes.map((n) => ({
          kind: 'note' as const,
          id: n.id,
          title: n.title,
          subtitle: n.folder_name ?? (n.visibility === 'private' ? 'Private' : 'No folder'),
          excerpt: excerptOf.get(n.id) ?? '',
          color: null,
          badge: null,
          url: `/notes?open=${n.id}`,
        })),
        ...events.map((e) => ({
          kind: 'event' as const,
          id: e.id,
          title: e.title,
          subtitle: e.location ?? e.calendar_name,
          excerpt: '',
          color: e.color,
          badge: e.starts_at.slice(0, 10),
          url: `/calendar?date=${e.starts_at.slice(0, 10)}`,
        })),
        ...projects.map((p) => ({
          kind: 'project' as const,
          id: p.id,
          title: p.title,
          subtitle: 'Project',
          excerpt: excerptOf.get(p.id) ?? '',
          color: p.color,
          badge: null,
          url: `/tasks?project=${p.id}`,
        })),
        ...attachments.map((a) => ({
          kind: 'attachment' as const,
          id: a.id,
          title: a.filename,
          subtitle: a.note_title ?? 'File',
          excerpt: '',
          color: null,
          badge: null,
          url: a.note_id ? `/notes?open=${a.note_id}` : `/api/attachments/${a.id}`,
        })),
      ],
    };
  });

  // ── Dashboard ──────────────────────────────────────────────────────────

  app.get('/api/dashboard', (req) => {
    // By the local clock: in UTC "today" is still yesterday after midnight
    const today = localToday();

    /*
      All three buckets go by the effective date: when an expected
      completion is set (#7), it replaces the due date — work that is in
      progress with a known finish day is not "overdue", it is simply
      scheduled for that day.
    */
    const dueToday = db
      .prepare(
        `SELECT t.*, p.title AS project_title, p.color AS project_color,
                u.name AS assignee_name, u.color AS assignee_color
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE coalesce(t.expected_date, t.due_date) = ?
            AND t.status NOT IN ('done','cancelled')
          ORDER BY t.priority DESC`,
      )
      .all(today);

    const overdue = db
      .prepare(
        `SELECT t.*, p.title AS project_title, p.color AS project_color,
                u.name AS assignee_name, u.color AS assignee_color
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE coalesce(t.expected_date, t.due_date) < ?
            AND t.status NOT IN ('done','cancelled')
          ORDER BY coalesce(t.expected_date, t.due_date)`,
      )
      .all(today);

    const upcoming = db
      .prepare(
        `SELECT t.*, p.title AS project_title, p.color AS project_color,
                u.name AS assignee_name, u.color AS assignee_color
           FROM tasks t JOIN projects p ON p.id = t.project_id
           LEFT JOIN users u ON u.id = t.assignee_id
          WHERE coalesce(t.expected_date, t.due_date) > ?
            AND coalesce(t.expected_date, t.due_date) <= date(?, '+7 days')
            AND t.status NOT IN ('done','cancelled')
          ORDER BY coalesce(t.expected_date, t.due_date)`,
      )
      .all(today, today);

    const recentNotes = db
      .prepare(
        `SELECT id, title, updated_at FROM notes
          WHERE is_template = 0 AND (visibility = 'shared' OR owner_id = ?)
          ORDER BY updated_at DESC LIMIT 5`,
      )
      .all(req.user?.id ?? '');

    const settings = Object.fromEntries(
      (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map(
        (r) => [r.key, r.value],
      ),
    );

    const userId = req.user?.id ?? '';
    const todayEvents = listOccurrences(userId, today, today);
    const reminders = remindersFor(userId, today);

    return { today, dueToday, overdue, upcoming, recentNotes, todayEvents, reminders, settings };
  });
}

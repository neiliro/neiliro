import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, invalidateTimezone, now, today as familyToday } from '../db/index.js';
import { isValidTimezone } from '../lib/timezone.js';
import { env } from '../env.js';
import { listOccurrences, remindersFor } from './calendar.js';
import { ATTACHMENT_VISIBLE, ATTACHMENT_VISIBLE_JOINS } from './attachments.js';

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
    // The family's timezone is the one setting that is not just a label:
    // today() computes money, budgets and recurrence from it. An unusable
    // name would not fail here, it would fail later and elsewhere, so it is
    // rejected at the door. Empty means "clear it" — back to the process clock.
    const tz = parsed.data['home.timezone'];
    if (tz !== undefined && tz.trim() !== '' && !isValidTimezone(tz.trim())) {
      return reply.code(400).send({ error: 'Unknown timezone' });
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
    // Unconditional: cheaper than deciding whether the zone was among the
    // keys, and the next today() pays one indexed read of a tiny table.
    invalidateTimezone();
    return { ok: true };
  });

  // ── Global search ───────────────────────────────────────────────────────

  /*
    The searchable corpus, for a search that runs in the browser (#216).

    Once titles and bodies are ciphertext the server cannot match a query
    against them; what it still can do — and must — is decide who may see
    which row. This endpoint applies exactly the visibility rules the old
    /api/search applied (owner_id for notes, calendar sharing for events,
    the attachment joins from #184) and returns the rows with their text
    fields as stored, encrypted or not. The browser decrypts and matches.
    A family's corpus is thousands of rows; the caps keep one family from
    spending everybody's event loop, same as the list endpoints.
  */
  app.get('/api/search/corpus', (req) => {
    const userId = req.user?.id ?? '';
    const notes = db
      .prepare(
        `SELECT n.id, n.title, n.body_md, n.visibility, n.is_template, f.name AS folder_name
           FROM notes n LEFT JOIN folders f ON f.id = n.folder_id
          WHERE (n.visibility = 'shared' OR n.owner_id = ?)
          ORDER BY n.updated_at DESC LIMIT 2000`,
      )
      .all(userId);
    const tasks = db
      .prepare(
        `SELECT t.id, t.title, t.description, t.status, t.due_date, t.project_id,
                p.title AS project_title, p.color
           FROM tasks t JOIN projects p ON p.id = t.project_id
          ORDER BY t.updated_at DESC LIMIT 5000`,
      )
      .all();
    const projects = db.prepare('SELECT id, title, description, color FROM projects').all();
    const events = db
      .prepare(
        `SELECT e.id, e.title, e.description, e.location, e.starts_at, e.calendar_id, e.profile_user_id,
                c.name AS calendar_name, c.color
           FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE (c.shared = 1 OR c.owner_id = ?)
          ORDER BY e.starts_at DESC LIMIT 5000`,
      )
      .all(userId);
    const attachments = db
      .prepare(
        `SELECT a.id, a.filename, a.mime, a.size_bytes, a.encryption, a.note_id, a.transaction_id,
                a.mail_message_id, n.title AS note_title
           FROM attachments a
           ${ATTACHMENT_VISIBLE_JOINS}
          WHERE ${ATTACHMENT_VISIBLE}
          ORDER BY a.created_at DESC LIMIT 5000`,
      )
      .all(userId, userId);
    return { notes, tasks, projects, events, attachments };
  });

  // ── Dashboard ──────────────────────────────────────────────────────────

  app.get('/api/dashboard', (req) => {
    // By the family's clock: in UTC "today" is still yesterday after midnight,
    // and on the server's clock it is somebody else's day entirely
    const today = familyToday();

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

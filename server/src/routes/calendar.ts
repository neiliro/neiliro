import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { db, id, now } from '../db/index.js';
import { buildCalendarFeed, type FeedEvent } from '../lib/ics.js';
import { expandOccurrences, isValidRecurrence } from '../lib/recurrence.js';
import { daysBetween, shiftDays } from '../lib/dates.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Time is stored as local wall-clock time, with no conversion to UTC.
 *
 * Most calendars do this for fixed-time events: "every Tuesday at 10:00"
 * must stay at 10:00 after the clocks change. Storing UTC would force
 * recomputing every instance of a series through DST rules — a source of
 * subtle bugs out of nowhere. The home lives in one time zone, and
 * Belgrade and Alicante happen to share it, so the move changes nothing.
 *
 * All-day event:    starts_at = 'YYYY-MM-DD'
 * Event with time:  starts_at = 'YYYY-MM-DDTHH:MM'
 */
const eventBase = z.object({
  calendar_id: z.string().uuid(),
  title: z.string().min(1, 'The event needs a title').max(300),
  description: z.string().max(10_000).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  // The message matches due_date in tasks.ts — without one, a malformed
  // date answers with zod's bare "Invalid", which names neither the field
  // nor the shape (#86)
  starts_at: z
    .string()
    .regex(
      new RegExp(`${DATE.source.slice(0, -1)}(T\\d{2}:\\d{2})?$`),
      'Date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM',
    ),
  ends_at: z
    .string()
    .regex(
      new RegExp(`${DATE.source.slice(0, -1)}(T\\d{2}:\\d{2})?$`),
      'Date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM',
    ),
  all_day: z.boolean().optional(),
  recurrence_rule: z.string().max(100).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  remind_days_before: z.number().int().min(0).max(365).nullable().optional(),
  birth_year: z.number().int().min(1900).max(2200).nullable().optional(),
  participants: z.array(z.string().uuid()).max(10).optional(),
});

const endsAfterStart = (v: { starts_at?: string; ends_at?: string }) =>
  v.starts_at === undefined || v.ends_at === undefined || v.ends_at >= v.starts_at;

const eventInput = eventBase.refine(endsAfterStart, {
  message: 'The event ends before it starts',
  path: ['ends_at'],
});

// A partial edit checks the same invariant, but only when both bounds
// arrived in the request
const eventPatch = eventBase.partial().refine(endsAfterStart, {
  message: 'The event ends before it starts',
  path: ['ends_at'],
});

interface EventRow {
  id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: number;
  recurrence_rule: string | null;
  project_id: string | null;
  remind_days_before: number | null;
  birth_year: number | null;
  calendar_name: string;
  calendar_color: string;
  project_title: string | null;
}

/** A calendar is visible if it is shared or belongs to the asker. */
const CALENDAR_VISIBLE = '(c.shared = 1 OR c.owner_id = ?)';

export interface Occurrence {
  id: string;
  event_id: string;
  date: string;
  starts_at: string;
  ends_at: string;
  title: string;
  description: string | null;
  location: string | null;
  all_day: number;
  is_recurring: boolean;
  calendar_id: string;
  calendar_name: string;
  calendar_color: string;
  project_id: string | null;
  project_title: string | null;
  remind_days_before: number | null;
  age: number | null;
  participants: { id: string; name: string; color: string }[];
}

/**
 * Expanded instances of all visible events within a date range.
 * Used by both the calendar and the dashboard — so that "today" is
 * computed exactly as it is shown in the grid.
 */
export function listOccurrences(userId: string, from: string, to: string): Occurrence[] {
  const events = db
    .prepare(
      `SELECT e.*, c.name AS calendar_name, c.color AS calendar_color,
              p.title AS project_title
         FROM events e
         JOIN calendars c ON c.id = e.calendar_id
         LEFT JOIN projects p ON p.id = e.project_id
        WHERE ${CALENDAR_VISIBLE}
          AND (
                e.recurrence_rule IS NOT NULL
                OR (substr(e.ends_at, 1, 10) >= ? AND substr(e.starts_at, 1, 10) <= ?)
              )`,
    )
    .all(userId, from, to) as EventRow[];

  const participantsOf = db.prepare(
    `SELECT u.id, u.name, u.color FROM event_participants ep
       JOIN users u ON u.id = ep.user_id
      WHERE ep.event_id = ?`,
  );
  const exceptionsOf = db.prepare('SELECT excluded_date FROM event_exceptions WHERE event_id = ?');

  const result: Occurrence[] = [];

  for (const event of events) {
    const anchor = event.starts_at.slice(0, 10);
    const span = daysBetween(anchor, event.ends_at.slice(0, 10));

    // A long event may have started before the window — step back by its duration
    const searchFrom = shiftDays(from, -Math.max(span, 0));
    const dates = expandOccurrences(anchor, event.recurrence_rule, searchFrom, to);

    const skipped = new Set(
      (exceptionsOf.all(event.id) as { excluded_date: string }[]).map((r) => r.excluded_date),
    );
    const participants = participantsOf.all(event.id) as {
      id: string;
      name: string;
      color: string;
    }[];

    for (const date of dates) {
      if (skipped.has(date)) continue;
      const endDate = shiftDays(date, span);
      if (endDate < from) continue;

      result.push({
        id: `${event.id}#${date}`,
        event_id: event.id,
        date,
        starts_at: event.all_day ? date : `${date}T${event.starts_at.slice(11)}`,
        ends_at: event.all_day ? endDate : `${endDate}T${event.ends_at.slice(11)}`,
        title: event.title,
        description: event.description,
        location: event.location,
        all_day: event.all_day,
        is_recurring: Boolean(event.recurrence_rule),
        calendar_id: event.calendar_id,
        calendar_name: event.calendar_name,
        calendar_color: event.calendar_color,
        project_id: event.project_id,
        project_title: event.project_title,
        remind_days_before: event.remind_days_before,
        age: event.birth_year ? Number(date.slice(0, 4)) - event.birth_year : null,
        participants,
      });
    }
  }

  return result.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** Events whose reminder is due precisely today. */
export function remindersFor(userId: string, today: string): Occurrence[] {
  return listOccurrences(userId, today, shiftDays(today, 365)).filter(
    (o) =>
      o.remind_days_before !== null &&
      o.date > today &&
      daysBetween(today, o.date) === o.remind_days_before,
  );
}

export async function registerCalendarRoutes(app: FastifyInstance): Promise<void> {
  // ── Calendars ───────────────────────────────────────────────────────────

  app.get('/api/calendars', (req) =>
    db
      .prepare(
        `SELECT c.*, (SELECT count(*) FROM events e WHERE e.calendar_id = c.id) AS event_count
           FROM calendars c
          WHERE ${CALENDAR_VISIBLE}
          ORDER BY c.shared DESC, c.position, c.name`,
      )
      .all(req.user?.id ?? ''),
  );

  app.post('/api/calendars', (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1, 'Enter a calendar name').max(100),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        shared: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const calendarId = id();
    db.prepare(
      `INSERT INTO calendars (id, name, color, owner_id, shared, position)
       VALUES (?, ?, ?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM calendars))`,
    ).run(
      calendarId,
      parsed.data.name.trim(),
      parsed.data.color ?? '#2E6F8E',
      req.user?.id ?? null,
      parsed.data.shared === false ? 0 : 1,
    );
    return reply.code(201).send(db.prepare('SELECT * FROM calendars WHERE id = ?').get(calendarId));
  });

  app.patch('/api/calendars/:id', (req, reply) => {
    const { id: calendarId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = z
      .object({
        name: z.string().min(1).max(100).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        shared: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });

    const calendar = db
      .prepare(`SELECT c.* FROM calendars c WHERE c.id = ? AND ${CALENDAR_VISIBLE}`)
      .get(calendarId, req.user?.id ?? '') as { owner_id: string | null } | undefined;
    if (!calendar) return reply.code(404).send({ error: 'Calendar not found' });

    // A personal calendar is managed by its owner alone
    if (calendar.owner_id && calendar.owner_id !== req.user?.id) {
      return reply.code(403).send({ error: 'This calendar belongs to someone else' });
    }

    const fields: [string, unknown][] = [];
    if (parsed.data.name !== undefined) fields.push(['name', parsed.data.name.trim()]);
    if (parsed.data.color !== undefined) fields.push(['color', parsed.data.color]);
    if (parsed.data.shared !== undefined) fields.push(['shared', parsed.data.shared ? 1 : 0]);
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });

    db.prepare(`UPDATE calendars SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...fields.map(([, v]) => v as string | number),
      calendarId,
    );
    return db.prepare('SELECT * FROM calendars WHERE id = ?').get(calendarId);
  });

  app.delete('/api/calendars/:id', (req, reply) => {
    const { id: calendarId } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Same lookup as the patch above: a personal calendar belongs to its
    // owner for deleting too, not only for reading.
    const visible = db
      .prepare(`SELECT c.id FROM calendars c WHERE c.id = ? AND ${CALENDAR_VISIBLE}`)
      .get(calendarId, req.user?.id ?? '');
    if (!visible) return reply.code(404).send({ error: 'Calendar not found' });

    const count = (
      db.prepare('SELECT count(*) AS n FROM events WHERE calendar_id = ?').get(calendarId) as {
        n: number;
      }
    ).n;
    if (count > 0) {
      return reply
        .code(409)
        .send({ error: `The calendar has ${count} ${count === 1 ? 'event' : 'events'}. Deleting the calendar deletes them too` });
    }

    const result = db.prepare('DELETE FROM calendars WHERE id = ?').run(calendarId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Calendar not found' });
    return { ok: true };
  });

  // ── Events ──────────────────────────────────────────────────────────────

  app.get('/api/events', (req, reply) => {
    const parsed = z
      .object({ from: z.string().regex(DATE), to: z.string().regex(DATE) })
      .safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Range boundaries from and to are required' });
    }
    if (daysBetween(parsed.data.from, parsed.data.to) > 400) {
      return reply.code(400).send({ error: 'There is no reason to request more than a year' });
    }
    return listOccurrences(req.user?.id ?? '', parsed.data.from, parsed.data.to);
  });

  /** The full series event — the recurrence rule and the rest an instance lacks. */
  app.get('/api/events/:id', (req, reply) => {
    const { id: eventId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const event = db
      .prepare(
        `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE e.id = ? AND ${CALENDAR_VISIBLE}`,
      )
      .get(eventId, req.user?.id ?? '');
    if (!event) return reply.code(404).send({ error: 'Event not found' });

    const participants = db
      .prepare(
        `SELECT u.id, u.name, u.color FROM event_participants ep
           JOIN users u ON u.id = ep.user_id
          WHERE ep.event_id = ?`,
      )
      .all(eventId);
    return { ...(event as object), participants };
  });

  app.post('/api/events', (req, reply) => {
    const parsed = eventInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;

    const calendar = db
      .prepare(`SELECT c.id FROM calendars c WHERE c.id = ? AND ${CALENDAR_VISIBLE}`)
      .get(d.calendar_id, req.user?.id ?? '');
    if (!calendar) return reply.code(400).send({ error: 'Calendar not found' });

    if (d.recurrence_rule && !isValidRecurrence(d.recurrence_rule)) {
      return reply.code(400).send({ error: 'Could not parse the recurrence rule' });
    }
    const allDay = d.all_day ?? !DATETIME.test(d.starts_at);
    if (!allDay && (!DATETIME.test(d.starts_at) || !DATETIME.test(d.ends_at))) {
      return reply.code(400).send({ error: 'A timed event needs hours and minutes' });
    }

    const eventId = id();
    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO events (id, calendar_id, title, description, location, starts_at, ends_at,
                             all_day, recurrence_rule, project_id, remind_days_before, birth_year,
                             created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        d.calendar_id,
        d.title.trim(),
        d.description ?? null,
        d.location ?? null,
        allDay ? d.starts_at.slice(0, 10) : d.starts_at,
        allDay ? d.ends_at.slice(0, 10) : d.ends_at,
        allDay ? 1 : 0,
        d.recurrence_rule ?? null,
        d.project_id ?? null,
        d.remind_days_before ?? null,
        d.birth_year ?? null,
        req.user?.id ?? null,
        now(),
        now(),
      );
      for (const userId of d.participants ?? []) {
        db.prepare(
          'INSERT OR IGNORE INTO event_participants (event_id, user_id) VALUES (?, ?)',
        ).run(eventId, userId);
      }
    });
    run();

    return reply.code(201).send(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
  });

  app.patch('/api/events/:id', (req, reply) => {
    const { id: eventId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = eventPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const event = db
      .prepare(
        `SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE e.id = ? AND ${CALENDAR_VISIBLE}`,
      )
      .get(eventId, req.user?.id ?? '') as EventRow | undefined;
    if (!event) return reply.code(404).send({ error: 'Event not found' });

    const d = parsed.data;
    if (d.recurrence_rule && !isValidRecurrence(d.recurrence_rule)) {
      return reply.code(400).send({ error: 'Could not parse the recurrence rule' });
    }

    const run = db.transaction(() => {
      const fields: [string, unknown][] = [];
      const set = (key: string, value: unknown) => fields.push([key, value]);

      if (d.calendar_id !== undefined) set('calendar_id', d.calendar_id);
      if (d.title !== undefined) set('title', d.title.trim());
      if (d.description !== undefined) set('description', d.description);
      if (d.location !== undefined) set('location', d.location);
      if (d.all_day !== undefined) set('all_day', d.all_day ? 1 : 0);
      if (d.starts_at !== undefined) set('starts_at', d.starts_at);
      if (d.ends_at !== undefined) set('ends_at', d.ends_at);
      if (d.recurrence_rule !== undefined) set('recurrence_rule', d.recurrence_rule);
      if (d.project_id !== undefined) set('project_id', d.project_id);
      if (d.remind_days_before !== undefined) set('remind_days_before', d.remind_days_before);
      if (d.birth_year !== undefined) set('birth_year', d.birth_year);

      if (fields.length > 0) {
        db.prepare(
          `UPDATE events SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ?
            WHERE id = ?`,
        ).run(...fields.map(([, v]) => v as string | number | null), now(), eventId);
      }

      if (d.participants !== undefined) {
        db.prepare('DELETE FROM event_participants WHERE event_id = ?').run(eventId);
        for (const userId of d.participants) {
          db.prepare(
            'INSERT OR IGNORE INTO event_participants (event_id, user_id) VALUES (?, ?)',
          ).run(eventId, userId);
        }
      }

      // Shifting the series resets exceptions: the old dates no longer refer to anything
      if (d.starts_at !== undefined || d.recurrence_rule !== undefined) {
        db.prepare('DELETE FROM event_exceptions WHERE event_id = ?').run(eventId);
      }
    });
    run();

    return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  });

  app.delete('/api/events/:id', (req, reply) => {
    const { id: eventId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const event = db
      .prepare(
        `SELECT e.id FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE e.id = ? AND ${CALENDAR_VISIBLE}`,
      )
      .get(eventId, req.user?.id ?? '');
    if (!event) return reply.code(404).send({ error: 'Event not found' });

    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    return { ok: true };
  });

  /** Cancel a single instance of a series without touching the series itself. */
  app.delete('/api/events/:id/occurrences/:date', (req, reply) => {
    const { id: eventId, date } = z
      .object({ id: z.string().uuid(), date: z.string().regex(DATE) })
      .parse(req.params);

    const event = db
      .prepare(
        `SELECT e.recurrence_rule FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE e.id = ? AND ${CALENDAR_VISIBLE}`,
      )
      .get(eventId, req.user?.id ?? '') as { recurrence_rule: string | null } | undefined;
    if (!event) return reply.code(404).send({ error: 'Event not found' });

    if (!event.recurrence_rule) {
      return reply
        .code(400)
        .send({ error: 'The event does not repeat — delete it entirely' });
    }

    db.prepare(
      'INSERT OR IGNORE INTO event_exceptions (event_id, excluded_date) VALUES (?, ?)',
    ).run(eventId, date);
    return { ok: true };
  });

  /*
    Subscribe-by-URL feed (#29 in part). Apple, Google and Outlook all
    subscribe to an ICS URL, so this puts the family calendar next to the
    work one on a phone without the hub having to become a CalDAV server.

    The token addresses one person's view: calendars can be private, so
    the feed shows exactly what its owner may see and nothing else. It is
    read-only by construction — there is no write path here at all.
  */

  app.get('/api/calendar/feed', (req) => {
    const row = db
      .prepare('SELECT calendar_feed_token AS token FROM users WHERE id = ?')
      .get(req.user!.id) as { token: string | null };
    // Returned in the clear, deliberately: the point of this link is to be
    // re-shown when a second device needs it (same reasoning as the
    // wishlist token, migration 021).
    return { token: row.token };
  });

  app.post('/api/calendar/feed', (req) => {
    const existing = db
      .prepare('SELECT calendar_feed_token AS token FROM users WHERE id = ?')
      .get(req.user!.id) as { token: string | null };
    if (existing.token) return { token: existing.token };

    const token = randomBytes(24).toString('base64url');
    db.prepare('UPDATE users SET calendar_feed_token = ? WHERE id = ?').run(token, req.user!.id);
    return { token };
  });

  app.delete('/api/calendar/feed', (req) => {
    // Revoking is the whole safety story for a link that lives in someone
    // else's calendar app: every subscribed device stops getting data.
    db.prepare('UPDATE users SET calendar_feed_token = NULL WHERE id = ?').run(req.user!.id);
    return { ok: true };
  });

  app.get('/api/calendar/feed/:token', (req, reply) => {
    // Clients like a .ics suffix; the token is the part before it
    const raw = (req.params as { token: string }).token;
    const token = raw.replace(/\.ics$/, '');

    const user = db
      .prepare('SELECT id FROM users WHERE calendar_feed_token = ? AND disabled_at IS NULL')
      .get(token) as { id: string } | undefined;
    // 404 rather than 401: an unguessable URL that does not exist should
    // look like any other missing page, and there is nothing to log in to
    if (!user) return reply.code(404).send({ error: 'Not found' });

    /*
      One-off events from a year back plus everything ahead; repeating
      events always, since their rule travels as RRULE and the client
      expands it. A year of history is what makes the calendar look
      populated when it is first added, without shipping the archive.
    */
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const events = db
      .prepare(
        `SELECT e.id, e.title, e.description, e.location, e.starts_at, e.ends_at,
                e.all_day, e.recurrence_rule
           FROM events e
           JOIN calendars c ON c.id = e.calendar_id
          WHERE ${CALENDAR_VISIBLE}
            AND (e.recurrence_rule IS NOT NULL OR e.ends_at >= ?)
          ORDER BY e.starts_at`,
      )
      .all(user.id, cutoff) as FeedEvent[];

    const home = db
      .prepare("SELECT value FROM settings WHERE key = 'home.name'")
      .get() as { value: string } | undefined;

    return reply
      .type('text/calendar; charset=utf-8')
      // Clients re-poll on their own schedule; nothing here is worth caching
      .header('cache-control', 'no-store')
      .send(buildCalendarFeed(home?.value?.trim() || 'Neiliro', events, new Date()));
  });
}

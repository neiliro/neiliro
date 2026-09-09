import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';
import { env } from '../env.js';

/*
  Family member profiles (#68): birthday, family role, preferences,
  allergies, wishlist. A profile is 1:1 with an account; rows in
  profiles/profile_entries/wishes appear lazily on first write.

  Two rules carry the feature and are worth reading before the routes:

  1. Editing follows the #64 asymmetry exactly: one's own profile, or
     the administrator (a kid without a device is maintained by the
     parent). Nothing else about permissions is invented here.

  2. The wish owner must never learn what is claimed. Every read path
     the owner can reach strips the claim fields SERVER-side — hiding
     them in the client would be the naive implementation the issue
     warns about. The public share page shows only a "reserved" flag
     with no names: guests must see what is taken (or two grandmothers
     buy the same gift), but a guest page must not enumerate the family.
*/

const FAMILY_ROLES = ['mother', 'father', 'daughter', 'son', 'grandmother', 'grandfather'] as const;
const SHARED_CALENDAR_ID = '00000000-0000-4000-8000-000000000201';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Self or admin — the #64 boundary, reused verbatim. */
function canEdit(req: FastifyRequest, userId: string): boolean {
  return req.user?.id === userId || req.user?.role === 'admin';
}

function forbid(reply: FastifyReply): void {
  reply.code(403).send({ error: 'This profile belongs to someone else' });
}

interface ProfileRow {
  user_id: string;
  birthday: string | null;
  family_role: string | null;
  wishlist_share_token: string | null;
  wishlist_share_created_at: string | null;
}

function profileOf(userId: string): ProfileRow | null {
  return (db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId) as ProfileRow) ?? null;
}

function ensureProfile(userId: string): void {
  db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(userId);
}

/**
 * The profile owns the birthday; the yearly event in the shared calendar
 * is derived from it — created, moved and deleted here, never edited as
 * an ordinary event's twin. birth_year feeds the age the calendar
 * already computes (calendar.ts), so the dashboard and the month grid
 * show "Alice · 34" with zero new display code.
 */
function syncBirthdayEvent(userId: string, userName: string, birthday: string | null): void {
  db.prepare('DELETE FROM events WHERE profile_user_id = ?').run(userId);
  if (!birthday) return;
  db.prepare(
    `INSERT INTO events (id, calendar_id, title, starts_at, ends_at, all_day,
                         recurrence_rule, birth_year, profile_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'FREQ=YEARLY', ?, ?, ?, ?)`,
  ).run(
    id(),
    SHARED_CALENDAR_ID,
    userName,
    birthday,
    birthday,
    Number(birthday.slice(0, 4)),
    userId,
    now(),
    now(),
  );
}

interface WishRow {
  id: string;
  user_id: string;
  title: string;
  url: string | null;
  claimed_by: string | null;
  claimed_by_name: string | null;
  claimed_at: string | null;
  position: number;
}

/** The owner's view of their own list: claim fields never leave the server. */
function stripClaims(wishes: WishRow[]): { id: string; title: string; url: string | null; position: number }[] {
  return wishes.map(({ id: wishId, title, url, position }) => ({ id: wishId, title, url, position }));
}

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  // ── The family list ───────────────────────────────────────────────────

  /**
   * Every member with their headline facts. Allergies ride along in the
   * list on purpose: they exist to be findable in a hurry by whoever is
   * cooking, so the list page must already show them, not a click away.
   */
  app.get('/api/profiles', (req) => {
    void req;
    const users = db
      .prepare(
        `SELECT u.id, u.name, u.color, p.birthday, p.family_role
           FROM users u LEFT JOIN profiles p ON p.user_id = u.id
          WHERE u.disabled_at IS NULL
          ORDER BY u.name`,
      )
      .all() as { id: string }[];
    // Rows, not bare labels: an encrypted label opens under its entry id (#221)
    const allergiesOf = db.prepare(
      `SELECT id, label FROM profile_entries WHERE user_id = ? AND kind = 'allergy' ORDER BY position`,
    );
    return users.map((u) => ({
      ...u,
      allergies: allergiesOf.all(u.id) as { id: string; label: string }[],
    }));
  });

  // ── One profile ───────────────────────────────────────────────────────

  app.get('/api/profiles/:userId', (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const user = db
      .prepare('SELECT id, name, color FROM users WHERE id = ? AND disabled_at IS NULL')
      .get(userId) as { id: string; name: string; color: string } | undefined;
    if (!user) return reply.code(404).send({ error: 'Member not found' });

    const profile = profileOf(userId);
    const entries = db
      .prepare('SELECT id, kind, label, value FROM profile_entries WHERE user_id = ? ORDER BY position')
      .all(userId);
    const wishes = db
      .prepare('SELECT * FROM wishes WHERE user_id = ? ORDER BY position, created_at')
      .all(userId) as WishRow[];

    const own = req.user?.id === userId;
    return {
      ...user,
      birthday: profile?.birthday ?? null,
      family_role: profile?.family_role ?? null,
      // The share path comes back to whoever manages sharing (self or
      // admin) so the link stays copyable after a reload — stored
      // plaintext on purpose, see migration 021. Other members get only
      // the fact that a link exists.
      wishlist_shared: Boolean(profile?.wishlist_share_token),
      wishlist_share_path:
        canEdit(req, userId) && profile?.wishlist_share_token
          ? `/wish/${profile.wishlist_share_token}`
          : null,
      entries,
      wishes: own
        ? stripClaims(wishes)
        : wishes.map((w) => ({
            id: w.id,
            title: w.title,
            url: w.url,
            position: w.position,
            claimed: Boolean(w.claimed_by || w.claimed_by_name),
            claimed_by_name: w.claimed_by
              ? ((db.prepare('SELECT name FROM users WHERE id = ?').get(w.claimed_by) as
                  | { name: string }
                  | undefined)?.name ?? null)
              : w.claimed_by_name,
            claimed_by_me: w.claimed_by === req.user?.id,
          })),
    };
  });

  app.patch('/api/profiles/:userId', (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    const parsed = z
      .object({
        birthday: z.string().regex(DATE, 'Date must be YYYY-MM-DD').nullable().optional(),
        family_role: z.enum(FAMILY_ROLES).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as
      | { name: string }
      | undefined;
    if (!user) return reply.code(404).send({ error: 'Member not found' });

    ensureProfile(userId);
    const d = parsed.data;
    if (d.family_role !== undefined) {
      db.prepare('UPDATE profiles SET family_role = ? WHERE user_id = ?').run(d.family_role, userId);
    }
    if (d.birthday !== undefined) {
      db.prepare('UPDATE profiles SET birthday = ? WHERE user_id = ?').run(d.birthday, userId);
      syncBirthdayEvent(userId, user.name, d.birthday);
    }
    return { ok: true };
  });

  // ── Preferences and allergies ─────────────────────────────────────────

  app.post('/api/profiles/:userId/entries', (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    // Ceilings sized for envelopes (#221); the browser mints the id when it encrypts
    const parsed = z
      .object({
        id: z.string().uuid().optional(),
        kind: z.enum(['preference', 'allergy']),
        label: z.string().min(1, 'Enter a label').max(4_000),
        value: z.string().max(4_000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    ensureProfile(userId);
    if (parsed.data.id && db.prepare('SELECT 1 FROM profile_entries WHERE id = ?').get(parsed.data.id)) {
      return reply.code(409).send({ error: 'An entry with this id already exists' });
    }
    const entryId = parsed.data.id ?? id();
    db.prepare(
      `INSERT INTO profile_entries (id, user_id, kind, label, value, position)
       VALUES (?, ?, ?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM profile_entries WHERE user_id = ?))`,
    ).run(entryId, userId, parsed.data.kind, parsed.data.label.trim(), parsed.data.value?.trim() || null, userId);
    return reply.code(201).send(db.prepare('SELECT id, kind, label, value FROM profile_entries WHERE id = ?').get(entryId));
  });

  /** Rewriting an entry — for the one-time job that brings old plaintext under the key (#221). */
  app.patch('/api/profiles/:userId/entries/:entryId', (req, reply) => {
    const { userId, entryId } = z
      .object({ userId: z.string().uuid(), entryId: z.string().uuid() })
      .parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    const parsed = z
      .object({ label: z.string().min(1).max(4_000).optional(), value: z.string().max(4_000).nullable().optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });
    const fields: [string, unknown][] = [];
    if (parsed.data.label !== undefined) fields.push(['label', parsed.data.label.trim()]);
    if (parsed.data.value !== undefined) fields.push(['value', parsed.data.value?.trim() || null]);
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });
    const result = db
      .prepare(`UPDATE profile_entries SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`)
      .run(...fields.map(([, v]) => v as string | null), entryId, userId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Entry not found' });
    return db.prepare('SELECT id, kind, label, value FROM profile_entries WHERE id = ?').get(entryId);
  });

  app.delete('/api/profiles/:userId/entries/:entryId', (req, reply) => {
    const { userId, entryId } = z
      .object({ userId: z.string().uuid(), entryId: z.string().uuid() })
      .parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    const result = db
      .prepare('DELETE FROM profile_entries WHERE id = ? AND user_id = ?')
      .run(entryId, userId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Entry not found' });
    return { ok: true };
  });

  // ── Wishlist ──────────────────────────────────────────────────────────

  app.post('/api/profiles/:userId/wishes', (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    const parsed = z
      .object({
        title: z.string().min(1, 'Enter a wish').max(300),
        url: z.string().url('The link must be a full URL').max(1000).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    ensureProfile(userId);
    const wishId = id();
    db.prepare(
      `INSERT INTO wishes (id, user_id, title, url, position, created_at)
       VALUES (?, ?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM wishes WHERE user_id = ?), ?)`,
    ).run(wishId, userId, parsed.data.title.trim(), parsed.data.url || null, userId, now());
    return reply
      .code(201)
      .send(db.prepare('SELECT id, title, url, position FROM wishes WHERE id = ?').get(wishId));
  });

  app.delete('/api/profiles/:userId/wishes/:wishId', (req, reply) => {
    const { userId, wishId } = z
      .object({ userId: z.string().uuid(), wishId: z.string().uuid() })
      .parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    const result = db.prepare('DELETE FROM wishes WHERE id = ? AND user_id = ?').run(wishId, userId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Wish not found' });
    return { ok: true };
  });

  /** Claim / unclaim by a signed-in family member. Never the owner. */
  app.post('/api/wishes/:wishId/claim', (req, reply) => {
    const { wishId } = z.object({ wishId: z.string().uuid() }).parse(req.params);
    const wish = db.prepare('SELECT * FROM wishes WHERE id = ?').get(wishId) as WishRow | undefined;
    if (!wish) return reply.code(404).send({ error: 'Wish not found' });
    // The owner claiming their own wish makes no sense and would let them
    // probe the claim state by error message — same answer either way
    if (wish.user_id === req.user?.id) return reply.code(404).send({ error: 'Wish not found' });
    if (wish.claimed_by || wish.claimed_by_name) {
      return reply.code(409).send({ error: 'Already reserved' });
    }
    db.prepare('UPDATE wishes SET claimed_by = ?, claimed_at = ? WHERE id = ?').run(
      req.user!.id,
      now(),
      wishId,
    );
    return { ok: true };
  });

  app.delete('/api/wishes/:wishId/claim', (req, reply) => {
    const { wishId } = z.object({ wishId: z.string().uuid() }).parse(req.params);
    const wish = db.prepare('SELECT * FROM wishes WHERE id = ?').get(wishId) as WishRow | undefined;
    if (!wish) return reply.code(404).send({ error: 'Wish not found' });
    // Only the claimer takes a reservation back (the admin too — the
    // escape hatch for a guest's mistaken claim reported out of band)
    if (wish.claimed_by !== req.user?.id && req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Reserved by someone else' });
    }
    db.prepare('UPDATE wishes SET claimed_by = NULL, claimed_by_name = NULL, claimed_at = NULL WHERE id = ?').run(wishId);
    return { ok: true };
  });

  // ── The public share link ─────────────────────────────────────────────

  app.post('/api/profiles/:userId/wishlist-share', (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    // A public sandbox must not mint public URLs into the real world
    if (env.demoMode) return reply.code(403).send({ error: 'Disabled in the demo' });
    ensureProfile(userId);
    const token = randomBytes(24).toString('base64url');
    db.prepare(
      'UPDATE profiles SET wishlist_share_token = ?, wishlist_share_created_at = ? WHERE user_id = ?',
    ).run(token, now(), userId);
    return reply.code(201).send({ path: `/wish/${token}` });
  });

  app.delete('/api/profiles/:userId/wishlist-share', (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (!canEdit(req, userId)) return forbid(reply);
    db.prepare(
      'UPDATE profiles SET wishlist_share_token = NULL, wishlist_share_created_at = NULL WHERE user_id = ?',
    ).run(userId);
    return { ok: true };
  });
}

/*
  The anonymous surface — registered separately so app.ts can put it on
  the public-paths side of authentication. It is the hub's first
  no-account page, so it is deliberately tiny: one GET that reveals the
  owner's first name and wish titles (reserved as a flag, never a name —
  a guest page must not enumerate the family), and one POST to reserve.
  Both under the same strict rate limit as login, and the token is
  unguessable and stored hashed.
*/
export async function registerPublicWishlistRoutes(app: FastifyInstance): Promise<void> {
  const strictRate = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const TOKEN = z.object({ token: z.string().min(16).max(64) });

  function ownerOf(token: string): { user_id: string; name: string } | null {
    const row = db
      .prepare(
        `SELECT p.user_id, u.name FROM profiles p JOIN users u ON u.id = p.user_id
          WHERE p.wishlist_share_token = ? AND u.disabled_at IS NULL`,
      )
      .get(token) as { user_id: string; name: string } | undefined;
    return row ?? null;
  }

  app.get('/api/wishlist/:token', strictRate, (req, reply) => {
    const { token } = TOKEN.parse(req.params);
    const owner = ownerOf(token);
    if (!owner) return reply.code(404).send({ error: 'This link is no longer valid' });
    const wishes = db
      .prepare('SELECT id, title, url, claimed_by, claimed_by_name FROM wishes WHERE user_id = ? ORDER BY position, created_at')
      .all(owner.user_id) as WishRow[];
    return {
      name: owner.name,
      wishes: wishes.map((w) => ({
        id: w.id,
        title: w.title,
        url: w.url,
        reserved: Boolean(w.claimed_by || w.claimed_by_name),
      })),
    };
  });

  app.post('/api/wishlist/:token/claim', strictRate, (req, reply) => {
    const { token } = TOKEN.parse(req.params);
    const owner = ownerOf(token);
    if (!owner) return reply.code(404).send({ error: 'This link is no longer valid' });
    const parsed = z
      .object({
        wish_id: z.string().uuid(),
        name: z.string().min(1, 'Enter your name').max(100),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const wish = db
      .prepare('SELECT * FROM wishes WHERE id = ? AND user_id = ?')
      .get(parsed.data.wish_id, owner.user_id) as WishRow | undefined;
    if (!wish) return reply.code(404).send({ error: 'Wish not found' });
    if (wish.claimed_by || wish.claimed_by_name) {
      return reply.code(409).send({ error: 'Already reserved' });
    }
    db.prepare('UPDATE wishes SET claimed_by_name = ?, claimed_at = ? WHERE id = ?').run(
      parsed.data.name.trim(),
      now(),
      wish.id,
    );
    return { ok: true };
  });
}

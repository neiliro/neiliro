import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentTenant, db, id, invalidateTimezone, now } from '../db/index.js';
import { isValidTimezone } from '../lib/timezone.js';
import { createSession, setSessionCookie } from '../lib/auth.js';
import { hashPassword } from '../lib/password.js';
import { sendVerificationEmail } from './email-verify.js';
import { log } from '../lib/log.js';

/*
 * Distinct colors for joining members. Every visual identity in the hub
 * (avatars, event participants) leans on the account color, and with
 * the schema default alone the whole family came out the same blue —
 * "Mom" and "Daughter" indistinguishable at a glance.
 */
export const USER_COLORS = ['#1F6E8C', '#C4842B', '#6B8F5E', '#8C4A6B', '#7A5C9E', '#4A6B8C'];

function nextColor(): string {
  const used = (db.prepare('SELECT color FROM users').all() as { color: string }[]).map((r) =>
    r.color.toLowerCase(),
  );
  return (
    USER_COLORS.find((c) => !used.includes(c.toLowerCase())) ??
    USER_COLORS[used.length % USER_COLORS.length]!
  );
}

/*
  Initial setup and invites — onboarding without reading logs.

  Empty database: the hub, when opened, offers to create the first
  account — it becomes the admin. No passwords in the server log.

  Family members are then added by links: the admin creates a one-time
  link, the person opens it and fills in their own name, login and
  password. The link lives a week, is shown to its creator once
  (only the hash is stored) and goes dark after use.
*/

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

const nameField = z.string().trim().min(1, 'The name cannot be empty').max(80);
const emailField = z.string().trim().toLowerCase().email('Invalid login address').max(120);
const passwordField = z.string().min(10, 'Password must be at least 10 characters').max(200);

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface InviteRow {
  id: string;
  role: 'member' | 'kid';
  expires_at: string;
  used_at: string | null;
}

/** A live invite by token: not used and not expired. */
function liveInvite(token: string): InviteRow | null {
  const row = db
    .prepare('SELECT id, role, expires_at, used_at FROM invites WHERE token_hash = ?')
    .get(hashToken(token)) as InviteRow | undefined;
  if (!row || row.used_at || row.expires_at <= new Date().toISOString()) return null;
  return row;
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  // A strict limit on the public onboarding endpoints — same as on login
  const strictRate = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /*
    Initial setup. Works exactly once — while the database has no users
    at all. Afterwards it answers 403 forever: a race of two simultaneous
    setups is settled by the uniqueness of the moment, the check and the
    insert run in one transaction.
  */
  app.post('/api/auth/setup', strictRate, async (req, reply) => {
    // The hosted ghost (an unknown subdomain) claims to be set up, and
    // must act it: its shared decoy database may never grow an admin —
    // whoever "set it up" would own every nonexistent subdomain at once.
    if (currentTenant().ghost) {
      return reply.code(403).send({ error: 'The hub is already set up' });
    }
    const parsed = z
      .object({
        name: nameField,
        email: emailField,
        password: passwordField,
        // Sent by the browser, not asked of the person: the first screen is
        // not the place for a 400-entry dropdown, and the browser already
        // knows the answer. Correctable later in Settings.
        timezone: z.string().max(64).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const userId = id();

    const created = db.transaction(() => {
      const n = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
      if (n > 0) return false;
      // Explicit color: the schema default (#2E6F8E) is a near-twin of
      // USER_COLORS[0] (#1F6E8C) — without this, the palette that gives
      // invited members distinct colors never covered the admin, so a
      // two-person household still ended up with two look-alike avatars.
      db.prepare(
        `INSERT INTO users (id, email, name, role, password_hash, color, must_change_password, created_at)
         VALUES (?, ?, ?, 'admin', ?, ?, 0, ?)`,
      ).run(userId, parsed.data.email, parsed.data.name, passwordHash, nextColor(), now());
      // A zone we cannot use is dropped rather than raised: a browser with an
      // odd idea of its own timezone must not be able to block the one screen
      // that stands between a family and their hub.
      const tz = parsed.data.timezone?.trim();
      if (tz && isValidTimezone(tz)) {
        db.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('home.timezone', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(tz, now());
      }
      return true;
    })();

    if (!created) {
      return reply.code(403).send({ error: 'The hub is already set up' });
    }

    // The tenant may already have cached "no zone" from a today() before this.
    invalidateTimezone();

    log.info(`initial setup: admin ${parsed.data.email} created from ${req.ip}`);
    // Hosted only, and a no-op elsewhere: an address that nobody confirmed
    // cannot be used to recover the account, so the ask goes out at the one
    // moment the person is definitely paying attention.
    void sendVerificationEmail(userId);
    setSessionCookie(reply, createSession(userId, req.headers['user-agent'], req.ip));
    return reply.code(201).send({ ok: true });
  });

  // ── Invites: the admin side ────────────────────────────────────────────

  app.post('/api/invites', (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrators only' });
    }
    const parsed = z
      .object({ role: z.enum(['member', 'kid']).default('member') })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });

    const token = randomBytes(24).toString('base64url');
    const inviteId = id();
    db.prepare(
      `INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      inviteId,
      hashToken(token),
      parsed.data.role,
      req.user.id,
      now(),
      new Date(Date.now() + INVITE_TTL_MS).toISOString().replace('T', ' ').slice(0, 19),
    );

    // The token leaves the server exactly once — from then on only the hash lives
    return reply.code(201).send({ id: inviteId, path: `/join?token=${token}` });
  });

  app.get('/api/invites', (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrators only' });
    }
    return db
      .prepare(
        `SELECT i.id, i.role, i.created_at, i.expires_at,
                (i.used_at IS NOT NULL) AS used,
                u.name AS used_by_name
           FROM invites i
           LEFT JOIN users u ON u.id = i.used_by
          ORDER BY i.created_at DESC
          LIMIT 20`,
      )
      .all();
  });

  app.delete('/api/invites/:id', (req, reply) => {
    if (req.user?.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrators only' });
    }
    const { id: inviteId } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Used ones stay untouched — that's history now, not an invite
    db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(inviteId);
    return { ok: true };
  });

  // ── Invites: the invitee side (public) ─────────────────────────────────

  // Whoever opens the link learns whether it is alive before filling the form
  app.get('/api/auth/invite', strictRate, (req, reply) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.query);
    const invite = liveInvite(token);
    if (!invite) {
      return reply.code(404).send({ error: 'The link is invalid: expired or already used' });
    }
    return { valid: true };
  });

  app.post('/api/auth/join', strictRate, async (req, reply) => {
    const parsed = z
      .object({
        token: z.string().min(1),
        name: nameField,
        email: emailField,
        password: passwordField,
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const invite = liveInvite(parsed.data.token);
    if (!invite) {
      return reply.code(404).send({ error: 'The link is invalid: expired or already used' });
    }

    const exists = db
      .prepare('SELECT id FROM users WHERE lower(email) = ?')
      .get(parsed.data.email);
    if (exists) {
      return reply.code(409).send({ error: 'A user with this address already exists' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const userId = id();

    // A race of two visits via one link is settled by the transaction:
    // the second one sees used_at and gets refused
    const joined = db.transaction(() => {
      const fresh = db
        .prepare('SELECT used_at FROM invites WHERE id = ?')
        .get(invite.id) as { used_at: string | null };
      if (fresh.used_at) return false;
      db.prepare(
        `INSERT INTO users (id, email, name, role, password_hash, color, must_change_password, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(userId, parsed.data.email, parsed.data.name, invite.role, passwordHash, nextColor(), now());
      db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?').run(
        userId,
        now(),
        invite.id,
      );
      return true;
    })();

    if (!joined) {
      return reply.code(404).send({ error: 'The link is invalid: expired or already used' });
    }

    log.info(`invite join: ${parsed.data.email} (${invite.role}) from ${req.ip}`);
    void sendVerificationEmail(userId);
    setSessionCookie(reply, createSession(userId, req.headers['user-agent'], req.ip));
    return reply.code(201).send({ ok: true });
  });
}

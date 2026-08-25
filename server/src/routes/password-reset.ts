import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentTenant, db, id, now } from '../db/index.js';
import { env } from '../env.js';
import { destroyAllSessions } from '../lib/auth.js';
import { log } from '../lib/log.js';
import { sendServiceEmail, serviceMailAvailable } from '../lib/mail.js';
import { hashPassword } from '../lib/password.js';
import { familySlug } from '../lib/tenants.js';

/*
  Password reset by email — hosted only, on purpose.

  A self-hosted family owns its machine, so the recovery door is ssh plus
  scripts/admin-reset.mjs: stronger than an email flow, and it needs no
  mail server at all. Registering this route there would add an attack
  surface to replace a door that is already better.

  Two properties shape the code:

  - **It never reveals whether a login exists.** The answer is the same
    202 either way, and the mail is sent without awaiting it, so the reply
    is not slower when there is a mailbox to write to. An endpoint that
    said "no such user" would be an account oracle on a service whose
    whole design refuses to confirm that a family exists.
  - **A reset changes the password and nothing else.** The second factor
    stays on — otherwise a mailbox would be a way around TOTP — and a
    member who deliberately turned password sign-in off does not get it
    turned back on behind their back.
*/

const RESET_TTL_MS = 60 * 60 * 1000;

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface ResetRow {
  id: string;
  user_id: string;
  expires_at: string;
  used_at: string | null;
}

export async function registerPasswordResetRoutes(app: FastifyInstance): Promise<void> {
  // Hosted only, and only when the service can actually send. Absent
  // rather than answering "not configured": a route that exists but never
  // works is a promise the login screen would keep making.
  if (!env.hostedMode || !serviceMailAvailable()) return;

  const strictRate = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/password-reset', strictRate, (req, reply) => {
    const parsed = z
      .object({ email: z.string().trim().toLowerCase().email().max(120) })
      .safeParse(req.body);
    // Even a malformed address gets the neutral answer: the shape of the
    // error would otherwise separate "not an address" from "not a user".
    if (parsed.success) void issue(parsed.data.email);
    return reply.code(202).send({ ok: true });
  });

  app.post('/api/auth/password-reset/confirm', strictRate, async (req, reply) => {
    const parsed = z
      .object({
        token: z.string().min(1).max(200),
        password: z.string().min(10, 'Password must be at least 10 characters').max(200),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const row = db
      .prepare('SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?')
      .get(hashResetToken(parsed.data.token)) as ResetRow | undefined;
    if (!row || row.used_at || row.expires_at <= new Date().toISOString()) {
      return reply.code(400).send({ error: 'This link has expired — request a new one' });
    }

    const passwordHash = await hashPassword(parsed.data.password);
    db.transaction(() => {
      db.prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
      ).run(passwordHash, row.user_id);
      db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now(), row.id);
      // Every other unused link for this person dies with it
      db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(row.user_id);
    })();

    // Whoever held the old password loses their sessions — a reset is
    // also how someone evicts an intruder.
    destroyAllSessions(row.user_id);
    log.info('password reset completed');
    return reply.code(204).send();
  });

  /**
   * Issue a link and mail it. Runs detached from the response, so a
   * missing mailbox and a real one take the same time to answer.
   */
  async function issue(email: string): Promise<void> {
    try {
      const user = db
        .prepare(
          `SELECT id, name, password_login_disabled FROM users WHERE email = ?`,
        )
        .get(email) as { id: string; name: string; password_login_disabled: number } | undefined;

      // No such login, or one that deliberately has no password to reset.
      // Silence is the answer in both cases.
      if (!user || user.password_login_disabled) return;

      const { familyId } = currentTenant();
      const slug = familyId ? familySlug(familyId) : null;
      if (!slug) return; // the ghost, or a single-family install: nothing to link to

      const token = randomBytes(32).toString('base64url');
      const expires = new Date(Date.now() + RESET_TTL_MS).toISOString();
      db.transaction(() => {
        // One live link per person: a mailbox must never hold two working
        // resets, and the newest request is the one the person remembers
        db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);
        db.prepare(
          `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(id(), user.id, hashResetToken(token), now(), expires);
      })();

      const url = `https://${slug}.${env.hostedDomain}/reset?token=${token}`;
      await sendServiceEmail(
        email,
        'Reset your Neiliro password',
        [
          `Hello, ${user.name}.`,
          '',
          'Someone asked to reset the password for this address. If it was you,',
          'open the link below within the next hour:',
          '',
          url,
          '',
          'The link works once. If it was not you, ignore this message —',
          'nothing has changed, and your current password still works.',
        ].join('\n'),
      );
    } catch (err) {
      // The requester is told nothing either way, so a failure here has to
      // be visible to the operator or it is invisible entirely.
      log.error('password reset: could not issue a link', err);
    }
  }
}

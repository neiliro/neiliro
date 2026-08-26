import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';
import { env } from '../env.js';
import { log } from '../lib/log.js';
import { sendServiceEmail, serviceMailAvailable } from '../lib/mail.js';

/*
  Confirming that a person owns the address they sign in with.

  The login has always been an address in shape only — nothing checked
  ownership, and self-hosted installs legitimately use fictional ones. That
  was fine while the address was just an identifier. It stopped being fine
  when a forgotten password could be recovered through it: a typo at signup
  would mail a working reset link to a stranger, and that stranger would be
  one click from a family's data.

  So this exists wherever the reset exists — hosted, with service mail
  configured — and nowhere else. On a self-hosted hub an address is an
  identifier again, and asking someone to prove a mailbox they invented on
  purpose would be theatre.
*/

const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashVerifyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether this process can ask anyone to confirm an address. */
export function emailVerificationAvailable(): boolean {
  return env.hostedMode && serviceMailAvailable();
}

/**
 * Issue a confirmation link and mail it. Safe to call for any user: it is
 * a no-op when the feature is off, so callers (signup, invite) do not need
 * to know which mode they are in.
 */
export async function sendVerificationEmail(userId: string): Promise<void> {
  if (!emailVerificationAvailable()) return;
  try {
    const user = db
      .prepare('SELECT email, name, email_verified_at FROM users WHERE id = ?')
      .get(userId) as { email: string; name: string; email_verified_at: string | null } | undefined;
    if (!user || user.email_verified_at) return;

    const token = randomBytes(32).toString('base64url');
    db.transaction(() => {
      // One live link per person: the newest request is the one they hold
      db.prepare('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL').run(userId);
      db.prepare(
        `INSERT INTO email_verifications (id, user_id, email, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id(),
        userId,
        user.email,
        hashVerifyToken(token),
        now(),
        new Date(Date.now() + VERIFY_TTL_MS).toISOString(),
      );
    })();

    // The host is the family's own subdomain: the link only has to work in
    // a browser, and the session it may create belongs to that host.
    const url = `${env.publicUrl || `https://${env.hostedDomain}`}/verify-email?token=${token}`;
    await sendServiceEmail(
      user.email,
      'Confirm your Neiliro address',
      [
        `Hello, ${user.name}.`,
        '',
        'Confirm this address so it can be used to recover your account if',
        'you ever forget your password:',
        '',
        url,
        '',
        'The link works for a week. Until it is used, password recovery by',
        'email stays unavailable for this account — which is deliberate: an',
        'unconfirmed address is not proof of anything.',
      ].join('\n'),
    );
  } catch (err) {
    // Never fails the flow that triggered it — signing up must not break
    // because a mail provider hiccuped.
    log.error('email verification: could not send the link', err);
  }
}

export async function registerEmailVerifyRoutes(app: FastifyInstance): Promise<void> {
  if (!emailVerificationAvailable()) return;

  const strictRate = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /*
    Public on purpose: the link is opened wherever the mail was read, which
    is often another browser with no session. The token is the
    authorization, and it proves exactly one thing — that whoever holds it
    reads that mailbox.
  */
  app.post('/api/auth/email-verify', strictRate, (req, reply) => {
    const parsed = z.object({ token: z.string().min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'This link is not valid' });

    const row = db
      .prepare(
        'SELECT id, user_id, email, expires_at, used_at FROM email_verifications WHERE token_hash = ?',
      )
      .get(hashVerifyToken(parsed.data.token)) as
      | { id: string; user_id: string; email: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.used_at || row.expires_at <= new Date().toISOString()) {
      return reply.code(400).send({ error: 'This link has expired — request a new one' });
    }

    const user = db.prepare('SELECT email FROM users WHERE id = ?').get(row.user_id) as
      | { email: string }
      | undefined;
    // The address moved since the link was issued: confirming the old one
    // would mark the new one verified without anyone proving it.
    if (!user || user.email !== row.email) {
      return reply.code(400).send({ error: 'This link is not valid' });
    }

    db.transaction(() => {
      db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now(), row.user_id);
      db.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?').run(now(), row.id);
    })();
    return { ok: true };
  });

  /** Send it again, to the address on the account. Requires a session. */
  app.post('/api/profile/email-verify', strictRate, async (req) => {
    await sendVerificationEmail(req.user!.id);
    // Same answer whether or not a mail went out: an already-verified
    // account and a fresh link are not worth distinguishing here.
    return { ok: true };
  });
}

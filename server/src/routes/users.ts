import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../db/index.js';
import { clearSessionCookie, consumeTotp, destroyAllSessions, requireAdmin, ensureKdfSalt } from '../lib/auth.js';
import { verifyPassword } from '../lib/password.js';
import { AUTH_KEY_PATTERN } from '../lib/kdf.js';
import { eraseMember, otherAdminsExist } from '../lib/erase-member.js';
import { log } from '../lib/log.js';
import { generatePassword, hashPassword } from '../lib/password.js';
import { deriveAuthKey } from '../lib/kdf.js';
import { emailVerificationAvailable, sendVerificationEmail } from './email-verify.js';
import { retirePasswordEnvelope } from '../lib/keys.js';

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db
      .prepare(
        `SELECT id, email, name, role, color, created_at, last_login_at,
                disabled_at, must_change_password,
                (email_verified_at IS NOT NULL) AS email_verified,
                EXISTS (SELECT 1 FROM key_envelopes k
                         WHERE k.user_id = users.id AND k.kind = 'password' AND k.retired_at IS NULL)
                  AS key_envelope
           FROM users WHERE deleted_at IS NULL ORDER BY role, name`,
      )
      .all() as { email_verified: number }[];

    /*
      `email_verified` is deliberately tri-state: true, false, or null for
      "the question does not apply here".

      Confirmation only means something on a hub that can ask for it. A
      self-hosted family's login is an identifier people legitimately
      invent (name@hub.local in the docs), so a plain false would brand
      every row unconfirmed for a proof nobody will ever be asked to give.
      null lets the People list stay quiet there and flag it where it
      actually costs someone their recovery route.
    */
    const applies = emailVerificationAvailable();
    return rows.map((row) => ({
      ...row,
      email_verified: applies ? Boolean(row.email_verified) : null,
    }));
  });

  // Manual account creation is gone on purpose: invitation links cover
  // every case (for a kid without a device, the parent opens the link
  // themselves), and one path into the family beats two half-used ones.
  // Reset-password below still issues one-time passwords — that is
  // recovery, not creation.

  app.patch('/api/users/:id', (req, reply) => {
    const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Name and colour are personal identity, not system management: a
    // member edits their own, the administrator can edit anyone's (a kid
    // without a device is set up by the parent). This route accepts
    // nothing else — role and the disable switch have their own
    // admin-only endpoints, so self-service here widens nothing. (#64)
    if (req.user?.id !== userId && !requireAdmin(req, reply)) return;
    const parsed = z
      .object({
        name: z.string().min(1).max(100).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });

    const fields: [string, string][] = [];
    if (parsed.data.name !== undefined) fields.push(['name', parsed.data.name.trim()]);
    if (parsed.data.color !== undefined) fields.push(['color', parsed.data.color]);
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });

    const result = db
      .prepare(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map(([, v]) => v), userId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Member not found' });

    return db
      .prepare('SELECT id, email, name, role, color FROM users WHERE id = ?')
      .get(userId);
  });

  /*
    Change the login address — administrator only.

    Deliberately not part of PATCH above: name and colour are personal
    identity, an address is a credential, and on hosted it is the one thing
    password recovery hangs off. Keeping it admin-only also means a stolen
    session cannot quietly move the account to an attacker's mailbox and
    then "recover" it.

    It exists because the address is otherwise unchangeable, which made a
    signup typo permanent: unconfirmable, and so unrecoverable.
  */
  app.post('/api/users/:id/email', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = z
      .object({ email: z.string().trim().toLowerCase().email('Invalid login address').max(120) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as
      | { id: string; email: string }
      | undefined;
    if (!target) return reply.code(404).send({ error: 'Member not found' });
    if (target.email === parsed.data.email) return reply.code(400).send({ error: 'Nothing to change' });

    const taken = db
      .prepare('SELECT 1 FROM users WHERE email = ? AND id != ?')
      .get(parsed.data.email, userId);
    if (taken) return reply.code(409).send({ error: 'That login is already taken' });

    // The new address starts unconfirmed, whatever the old one was: the
    // proof belonged to the address, not to the account.
    db.prepare('UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?').run(
      parsed.data.email,
      userId,
    );
    log.info('login address changed by an administrator');
    void sendVerificationEmail(userId);

    return db.prepare('SELECT id, email, name, role, color FROM users WHERE id = ?').get(userId);
  });

  app.post('/api/users/:id/reset-password', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);

    const user = db.prepare('SELECT id, kdf_salt FROM users WHERE id = ?').get(userId) as
      | { id: string; kdf_salt: string | null }
      | undefined;
    if (!user) return reply.code(404).send({ error: 'Member not found' });

    const password = generatePassword();
    // The server picked this password, so it is the one party that can
    // run the browser's derivation for it: what gets stored is the hash of
    // the auth key the member's browser will produce from the same
    // password (lib/kdf.ts). It must be changed on first login, and the
    // change rewrites the hash with a key the server never saw.
    const authKey = await deriveAuthKey(password, ensureKdfSalt(user.id, user.kdf_salt));
    // A reset is also the recovery path for a dead Google account,
    // so password login gets switched back on
    const hash = await hashPassword(authKey);
    db.transaction(() => {
      db.prepare(
        `UPDATE users SET password_hash = ?, kdf_version = 1, must_change_password = 1,
                password_login_disabled = 0 WHERE id = ?`,
      ).run(hash, userId);
      // The new password opens nothing the old one wrapped (ADR 0001):
      // access is restored, the key is handed back by re-admission
      retirePasswordEnvelope(userId);
    })();
    // A password reset kicks the user off every device
    destroyAllSessions(userId);

    return { password };
  });

  app.post('/api/users/:id/toggle', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);

    if (userId === req.user?.id) {
      return reply.code(400).send({ error: 'You cannot disable yourself' });
    }

    const user = db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(userId) as
      | { disabled_at: string | null }
      | undefined;
    if (!user) return reply.code(404).send({ error: 'Member not found' });

    const disabled = user.disabled_at ? null : now();
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabled, userId);
    if (disabled) destroyAllSessions(userId);

    return { disabled: Boolean(disabled) };
  });

  /*
    Remove a member for good (GDPR art. 17). What goes and what stays is
    lib/erase-member.ts; this route decides who may ask. The administrator
    may remove anyone but themselves — their own exit is either the route
    below or, for the last administrator, deleting the family, because a
    hub with no administrator has no one to add the next one.
  */
  app.delete('/api/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id: userId } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (userId === req.user?.id) {
      return reply.code(400).send({ error: 'You cannot remove yourself here — use "Delete my account"' });
    }
    const user = db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(userId) as
      | { deleted_at: string | null }
      | undefined;
    if (!user || user.deleted_at) return reply.code(404).send({ error: 'Member not found' });
    await eraseMember(userId);
    return { ok: true };
  });

  /*
    Leave the family (GDPR art. 17, exercised by the person themselves).
    Proven with the password and the second factor, like family deletion:
    a stolen session must not be enough to erase someone. The last
    administrator is refused — the family cannot be left without one — and
    is pointed at family deletion instead.
  */
  const eraseInput = z.object({
    auth_key: z.string().regex(AUTH_KEY_PATTERN, 'Invalid credentials'),
    code: z.string().trim().min(6).max(8).optional(),
  });
  app.post('/api/users/me/erase', async (req, reply) => {
    const parsed = eraseInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });
    const me = req.user!;
    if (me.role === 'admin' && !otherAdminsExist(me.id)) {
      return reply
        .code(400)
        .send({ error: 'The last administrator cannot leave — delete the family, or make someone else an administrator first' });
    }
    const user = db
      .prepare('SELECT password_hash, totp_secret, totp_confirmed_at FROM users WHERE id = ?')
      .get(me.id) as { password_hash: string; totp_secret: string | null; totp_confirmed_at: string | null };
    if (!(await verifyPassword(parsed.data.auth_key, user.password_hash))) {
      return reply.code(400).send({ error: 'The current password is incorrect' });
    }
    if (user.totp_confirmed_at && user.totp_secret) {
      if (!parsed.data.code) return reply.code(400).send({ error: 'Enter the code' });
      if (!consumeTotp(me.id, user.totp_secret, parsed.data.code)) {
        return reply.code(401).send({ error: 'Wrong code' });
      }
    }
    await eraseMember(me.id);
    clearSessionCookie(reply);
    return { ok: true };
  });
}

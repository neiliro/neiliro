import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, now } from '../db/index.js';
import { log } from '../lib/log.js';
import {
  ENVELOPE_PATTERN,
  HANDOFF_TTL_MS,
  PUBLIC_KEY_PATTERN,
  familyKey,
  holdsKey,
  liveEnvelope,
  retireEnvelopes,
  storeEnvelope,
} from '../lib/keys.js';

/*
  The family key's doors (ADR 0001, #210).

  Nothing here can read what it stores. The browser generates the family
  key, wraps it, and sends envelopes; this file keeps them, says which ones
  a member still has, and refuses the few things the server *can* refuse:
  a second family key, a kid creating the key, a handoff from someone who
  has no envelope of their own. The last is a proxy — the server cannot
  tell who holds the key, only who has a live door to it — and it is the
  strongest check available without trusting the request.

  What never arrives: the family key, a wrap key, a recovery code, a
  handoff secret. The schemas below accept wrapped envelopes and one public
  key, and the shape of a `w1:` envelope does not fit a raw key — the
  test pins that.
*/

const envelopeField = z.string().regex(ENVELOPE_PATTERN, 'Not a key envelope');
const publicKeyField = z.string().regex(PUBLIC_KEY_PATTERN, 'Not a public key');

export async function registerKeyRoutes(app: FastifyInstance): Promise<void> {
  /** What this browser needs to open the key, or to learn that it cannot. */
  app.get('/api/keys', (req) => {
    const me = req.user!.id;
    const handoffs = db
      .prepare(
        `SELECT k.id, k.envelope, k.created_at, u.name AS created_by_name
           FROM key_envelopes k LEFT JOIN users u ON u.id = k.created_by
          WHERE k.user_id = ? AND k.kind = 'handoff' AND k.retired_at IS NULL AND k.created_at > ?
          ORDER BY k.created_at DESC`,
      )
      .all(me, new Date(Date.now() - HANDOFF_TTL_MS).toISOString());
    return {
      family: familyKey(),
      password_envelope: liveEnvelope(me, 'password'),
      recovery_envelope: liveEnvelope(null, 'recovery'),
      handoffs,
    };
  });

  /*
    The family key is born here — once. The browser of whoever gets here
    first with a wrap key in hand sends the public half, its own envelope
    and the recovery envelope in one request: a key with no recovery door
    must never exist, not even between two requests. Kids do not create it:
    the recovery code has to land with an adult.
  */
  app.post('/api/keys', (req, reply) => {
    const user = req.user!;
    if (user.role === 'kid') {
      return reply.code(403).send({ error: 'A family member sets up the key, not a kid account' });
    }
    const parsed = z
      .object({
        public_key: publicKeyField,
        envelope: envelopeField,
        recovery_envelope: envelopeField,
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Not a key envelope' });

    const created = db.transaction(() => {
      if (familyKey()) return false;
      db.prepare('INSERT INTO family_key (id, public_key, created_by, created_at) VALUES (1, ?, ?, ?)').run(
        parsed.data.public_key,
        user.id,
        now(),
      );
      storeEnvelope(user.id, 'password', parsed.data.envelope, user.id);
      storeEnvelope(null, 'recovery', parsed.data.recovery_envelope, user.id);
      return true;
    })();
    if (!created) return reply.code(409).send({ error: 'The family already has a key' });

    log.info(`family key created by ${user.email}`);
    return reply.code(201).send({ ok: true });
  });

  /*
    The member's own envelope, written by a browser that holds the key and
    a wrap key: after opening a handoff or the recovery code, or after the
    first sign-in of an account from before the split. Replaces the previous
    one and retires any handoff still addressed to this member — it has
    served its purpose or was never needed.
  */
  app.put('/api/keys/envelope', (req, reply) => {
    const me = req.user!.id;
    const parsed = z.object({ envelope: envelopeField }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Not a key envelope' });
    if (!familyKey()) return reply.code(409).send({ error: 'The family has no key yet' });
    db.transaction(() => {
      retireEnvelopes(me, 'password');
      retireEnvelopes(me, 'handoff');
      storeEnvelope(me, 'password', parsed.data.envelope, me);
    })();
    return { ok: true };
  });

  /*
    A new recovery code — the old envelope is replaced, never merely
    removed, so the family is never without that door. Only a member with a
    live envelope may do it: the code is minted in the browser and wrapped
    with the key, and this is the server's proxy for "has the key".
  */
  app.post('/api/keys/recovery', (req, reply) => {
    const me = req.user!;
    if (me.role === 'kid') return reply.code(403).send({ error: 'A family member does this, not a kid account' });
    const parsed = z.object({ recovery_envelope: envelopeField }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Not a key envelope' });
    if (!familyKey()) return reply.code(409).send({ error: 'The family has no key yet' });
    if (!holdsKey(me.id)) {
      return reply.code(403).send({ error: 'Only a member who holds the key can issue a new recovery code' });
    }
    db.transaction(() => {
      retireEnvelopes(null, 'recovery');
      storeEnvelope(null, 'recovery', parsed.data.recovery_envelope, me.id);
    })();
    log.info(`recovery code replaced by ${me.email}`);
    return { ok: true };
  });

  /*
    Re-admission (#210), and the mechanism invitations reuse (#212): a
    member holding the key wraps it for another under a random secret. The
    envelope is stored here; the secret leaves the inviting browser only
    inside the fragment of a link, which browsers never send. One live
    handoff per member — a second one replaces the first.
  */
  app.post('/api/keys/handoff', (req, reply) => {
    const me = req.user!;
    if (me.role === 'kid') return reply.code(403).send({ error: 'A family member does this, not a kid account' });
    const parsed = z.object({ user_id: z.string().uuid(), envelope: envelopeField }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Not a key envelope' });
    if (!familyKey()) return reply.code(409).send({ error: 'The family has no key yet' });
    if (!holdsKey(me.id)) {
      return reply.code(403).send({ error: 'Only a member who holds the key can hand it on' });
    }
    if (parsed.data.user_id === me.id) return reply.code(400).send({ error: 'You already hold the key' });
    const target = db
      .prepare('SELECT id, name FROM users WHERE id = ? AND disabled_at IS NULL')
      .get(parsed.data.user_id) as { id: string; name: string } | undefined;
    if (!target) return reply.code(404).send({ error: 'Member not found' });

    const handoffId = db.transaction(() => {
      retireEnvelopes(target.id, 'handoff');
      return storeEnvelope(target.id, 'handoff', parsed.data.envelope, me.id);
    })();
    log.info(`key handoff for ${target.name} issued by ${me.email}`);
    return reply.code(201).send({ id: handoffId });
  });

  /**
   * Retire a handoff: its creator revoking it, the administrator, or the
   * member it was made for once they have opened it (a browser without a
   * wrap key cannot write the envelope that would retire it otherwise).
   */
  app.delete('/api/keys/handoff/:id', (req, reply) => {
    const me = req.user!;
    const { id: handoffId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = db
      .prepare(
        `UPDATE key_envelopes SET retired_at = ?
          WHERE id = ? AND kind = 'handoff' AND retired_at IS NULL
            AND (created_by = ? OR user_id = ? OR ?)`,
      )
      .run(now(), handoffId, me.id, me.id, me.role === 'admin' ? 1 : 0);
    if (result.changes === 0) return reply.code(404).send({ error: 'Handoff not found' });
    return { ok: true };
  });
}

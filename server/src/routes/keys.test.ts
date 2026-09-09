import { describe, expect, it } from 'vitest';
import { SALT, authKey, buildTestApp } from '../test-harness.js';
import { hashPassword } from '../lib/password.js';
import { createSession } from '../lib/auth.js';
import { id, now, runWithDb } from '../db/index.js';
import { ENVELOPE_PATTERN, PUBLIC_KEY_PATTERN } from '../lib/keys.js';

/*
  The family key's doors (ADR 0001, #210), from the server's side.

  The server never sees the family key, a wrap key, a recovery code or a
  handoff secret; it stores envelopes and knows who has which door. The
  tests here pin exactly that: what the routes accept, what they refuse,
  and that every password reset kills the envelope the old password
  protected. Opening envelopes is the browser's business and is tested
  in web/src/lib/crypto.
*/

type Harness = Awaited<ReturnType<typeof buildTestApp>>;

// Wire-shaped fixtures: a `w1:` envelope is a 16-char nonce and 64 chars of
// ciphertext (12 + 48 bytes, base64url); a public key is 32 bytes → 43 chars.
const b64 = (n: number, c = 'A') => c.repeat(n);
const envelope = (c = 'A') => `w1:${b64(16, c)}:${b64(64, c)}`;
const PUBLIC_KEY = b64(43, 'B');
/** What a raw 32-byte key looks like in base64url — must never be accepted as an envelope. */
const RAW_KEY = b64(43, 'C');

async function member(h: Harness, name: string, role: 'admin' | 'member' | 'kid' = 'member') {
  const hash = await hashPassword(await authKey(`${name} password 12`));
  return runWithDb(h.db, () => {
    const userId = id();
    h.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, kdf_version, kdf_salt, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(userId, `${name.toLowerCase()}@hub.local`, name, role, hash, SALT, now());
    return { userId, cookie: createSession(userId, `${name}-device`) };
  });
}

const createKey = (h: Harness, cookie: string, body: unknown = {}) =>
  h.as(cookie, 'POST', '/api/keys', {
    public_key: PUBLIC_KEY,
    envelope: envelope('D'),
    recovery_envelope: envelope('R'),
    ...(body as object),
  });

describe('the wire shape', () => {
  it('an envelope is a wrapped key, never a bare one', () => {
    expect(ENVELOPE_PATTERN.test(envelope())).toBe(true);
    expect(ENVELOPE_PATTERN.test(RAW_KEY)).toBe(false);
    expect(ENVELOPE_PATTERN.test(`w1:${b64(16)}:${RAW_KEY}`)).toBe(false);
    expect(ENVELOPE_PATTERN.test(`e1:${b64(16)}:${b64(64)}`)).toBe(false);
    expect(PUBLIC_KEY_PATTERN.test(PUBLIC_KEY)).toBe(true);
    expect(PUBLIC_KEY_PATTERN.test(envelope())).toBe(false);
  });
});

describe('creating the family key', () => {
  it('happens once, by an adult, with the recovery door in the same request', async () => {
    const h = await buildTestApp();
    const kid = await member(h, 'Kid', 'kid');
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');

    expect((await h.as(sam.cookie, 'GET', '/api/keys')).json()).toEqual({
      family: null,
      password_envelope: null,
      recovery_envelope: null,
      handoffs: [],
    });

    expect((await createKey(h, kid.cookie)).statusCode).toBe(403);
    // No recovery envelope, no key: a key with a single door must never exist
    expect((await createKey(h, sam.cookie, { recovery_envelope: undefined })).statusCode).toBe(400);
    // A raw key in place of an envelope is refused by shape
    expect((await createKey(h, sam.cookie, { envelope: RAW_KEY })).statusCode).toBe(400);

    expect((await createKey(h, sam.cookie)).statusCode).toBe(201);
    expect((await createKey(h, ann.cookie)).statusCode).toBe(409);

    const mine = (await h.as(sam.cookie, 'GET', '/api/keys')).json<{
      family: { public_key: string; created_at: string };
      password_envelope: string;
      recovery_envelope: string;
    }>();
    expect(mine.family.public_key).toBe(PUBLIC_KEY);
    expect(mine.password_envelope).toBe(envelope('D'));
    expect(mine.recovery_envelope).toBe(envelope('R'));

    // Ann has the family's recovery envelope to try a code against, and no envelope of her own yet
    const hers = (await h.as(ann.cookie, 'GET', '/api/keys')).json<{ password_envelope: null; recovery_envelope: string }>();
    expect(hers.password_envelope).toBeNull();
    expect(hers.recovery_envelope).toBe(envelope('R'));
  });

  it('a member writes their own envelope once they hold the key; before the key exists there is nothing to wrap', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');
    expect((await h.as(ann.cookie, 'PUT', '/api/keys/envelope', { envelope: envelope('E') })).statusCode).toBe(409);
    await createKey(h, sam.cookie);
    expect((await h.as(ann.cookie, 'PUT', '/api/keys/envelope', { envelope: envelope('E') })).statusCode).toBe(200);
    expect((await h.as(ann.cookie, 'GET', '/api/keys')).json<{ password_envelope: string }>().password_envelope).toBe(
      envelope('E'),
    );
    // Replacing keeps one live envelope, not two
    await h.as(ann.cookie, 'PUT', '/api/keys/envelope', { envelope: envelope('F') });
    expect((await h.as(ann.cookie, 'GET', '/api/keys')).json<{ password_envelope: string }>().password_envelope).toBe(
      envelope('F'),
    );
    const live = runWithDb(h.db, () =>
      h.db.prepare("SELECT count(*) AS n FROM key_envelopes WHERE user_id = ? AND kind = 'password' AND retired_at IS NULL").get(ann.userId),
    ) as { n: number };
    expect(live.n).toBe(1);
  });
});

describe('handing the key on', () => {
  it('only a member with a live envelope can hand off, and only to someone else', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');
    const bob = await member(h, 'Bob');
    const kid = await member(h, 'Kid', 'kid');
    await createKey(h, sam.cookie);

    // Ann holds nothing yet: she cannot hand on what she does not have
    expect((await h.as(ann.cookie, 'POST', '/api/keys/handoff', { user_id: bob.userId, envelope: envelope('H') })).statusCode).toBe(403);
    expect((await h.as(sam.cookie, 'POST', '/api/keys/handoff', { user_id: sam.userId, envelope: envelope('H') })).statusCode).toBe(400);
    expect((await h.as(sam.cookie, 'POST', '/api/keys/handoff', { user_id: '00000000-0000-4000-8000-000000000000', envelope: envelope('H') })).statusCode).toBe(404);
    expect((await h.as(kid.cookie, 'POST', '/api/keys/handoff', { user_id: bob.userId, envelope: envelope('H') })).statusCode).toBe(403);

    const first = await h.as(sam.cookie, 'POST', '/api/keys/handoff', { user_id: ann.userId, envelope: envelope('H') });
    expect(first.statusCode).toBe(201);
    const second = await h.as(sam.cookie, 'POST', '/api/keys/handoff', { user_id: ann.userId, envelope: envelope('I') });
    expect(second.statusCode).toBe(201);

    // Ann sees exactly the latest one, and who made it
    const hers = (await h.as(ann.cookie, 'GET', '/api/keys')).json<{ handoffs: { id: string; envelope: string; created_by_name: string }[] }>();
    expect(hers.handoffs).toHaveLength(1);
    expect(hers.handoffs[0]!.envelope).toBe(envelope('I'));
    expect(hers.handoffs[0]!.created_by_name).toBe('Sam');
    // Nobody else sees it
    expect((await h.as(bob.cookie, 'GET', '/api/keys')).json<{ handoffs: unknown[] }>().handoffs).toEqual([]);

    // Writing her own envelope retires the handoff: it has done its job
    await h.as(ann.cookie, 'PUT', '/api/keys/envelope', { envelope: envelope('E') });
    expect((await h.as(ann.cookie, 'GET', '/api/keys')).json<{ handoffs: unknown[] }>().handoffs).toEqual([]);
    // ...and now she can hand on herself
    expect((await h.as(ann.cookie, 'POST', '/api/keys/handoff', { user_id: bob.userId, envelope: envelope('J') })).statusCode).toBe(201);
  });

  it('a handoff is retired by its creator, the administrator or the member it is for — not by a bystander', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');
    const bob = await member(h, 'Bob');
    const kid = await member(h, 'Kid', 'kid');
    await createKey(h, sam.cookie);
    await h.as(ann.cookie, 'PUT', '/api/keys/envelope', { envelope: envelope('E') });

    const { id: byAnn } = (await h.as(ann.cookie, 'POST', '/api/keys/handoff', { user_id: bob.userId, envelope: envelope('H') })).json<{ id: string }>();
    expect((await h.as(kid.cookie, 'DELETE', `/api/keys/handoff/${byAnn}`)).statusCode).toBe(404);
    expect((await h.as(sam.cookie, 'DELETE', `/api/keys/handoff/${byAnn}`)).statusCode).toBe(200);

    // The member it was made for retires it after opening it — a browser
    // with no wrap key has no envelope to write and would otherwise leave it live
    const { id: forBob } = (await h.as(ann.cookie, 'POST', '/api/keys/handoff', { user_id: bob.userId, envelope: envelope('L') })).json<{ id: string }>();
    expect((await h.as(bob.cookie, 'DELETE', `/api/keys/handoff/${forBob}`)).statusCode).toBe(200);
    expect((await h.as(bob.cookie, 'GET', '/api/keys')).json<{ handoffs: unknown[] }>().handoffs).toEqual([]);

    const { id: again } = (await h.as(ann.cookie, 'POST', '/api/keys/handoff', { user_id: bob.userId, envelope: envelope('K') })).json<{ id: string }>();
    expect((await h.as(ann.cookie, 'DELETE', `/api/keys/handoff/${again}`)).statusCode).toBe(200);
  });

  it('a new recovery code replaces the old one and needs a key holder', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');
    await createKey(h, sam.cookie);
    expect((await h.as(ann.cookie, 'POST', '/api/keys/recovery', { recovery_envelope: envelope('S') })).statusCode).toBe(403);
    expect((await h.as(sam.cookie, 'POST', '/api/keys/recovery', { recovery_envelope: envelope('S') })).statusCode).toBe(200);
    expect((await h.as(ann.cookie, 'GET', '/api/keys')).json<{ recovery_envelope: string }>().recovery_envelope).toBe(envelope('S'));
    const live = runWithDb(h.db, () =>
      h.db.prepare("SELECT count(*) AS n FROM key_envelopes WHERE kind = 'recovery' AND retired_at IS NULL").get(),
    ) as { n: number };
    expect(live.n).toBe(1);
  });
});

describe('a password the browser never wrapped with kills the envelope', () => {
  it('the administrator resetting a member', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');
    await createKey(h, sam.cookie);
    await h.as(ann.cookie, 'PUT', '/api/keys/envelope', { envelope: envelope('E') });

    const before = (await h.as(sam.cookie, 'GET', '/api/users')).json<{ id: string; key_envelope: number }[]>();
    expect(before.find((u) => u.id === ann.userId)!.key_envelope).toBe(1);

    expect((await h.as(sam.cookie, 'POST', `/api/users/${ann.userId}/reset-password`, {})).statusCode).toBe(200);

    const after = (await h.as(sam.cookie, 'GET', '/api/users')).json<{ id: string; key_envelope: number }[]>();
    expect(after.find((u) => u.id === ann.userId)!.key_envelope).toBe(0);
    // The row is retired, not deleted: the fact that it once existed stays
    const rows = runWithDb(h.db, () =>
      h.db.prepare("SELECT retired_at FROM key_envelopes WHERE user_id = ? AND kind = 'password'").all(ann.userId),
    ) as { retired_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retired_at).not.toBeNull();
  });

  it('a password change re-wraps in the same request, or retires when the browser holds no key', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    await createKey(h, sam.cookie);

    const current = await authKey('Sam password 12');
    const next = await authKey('a brand new password');
    // A browser holding the key sends the re-wrapped envelope along
    const changed = await h.as(sam.cookie, 'POST', '/api/auth/change-password', {
      current_auth_key: current,
      new_auth_key: next,
      envelope: envelope('N'),
    });
    expect(changed.statusCode).toBe(200);
    let session = runWithDb(h.db, () => createSession(sam.userId, 'laptop'));
    expect((await h.as(session, 'GET', '/api/keys')).json<{ password_envelope: string }>().password_envelope).toBe(envelope('N'));

    // A browser that does not hold the key cannot re-wrap: the envelope dies honestly
    const changedBlind = await h.as(session, 'POST', '/api/auth/change-password', {
      current_auth_key: next,
      new_auth_key: await authKey('yet another password'),
    });
    expect(changedBlind.statusCode).toBe(200);
    session = runWithDb(h.db, () => createSession(sam.userId, 'laptop'));
    expect((await h.as(session, 'GET', '/api/keys')).json<{ password_envelope: null }>().password_envelope).toBeNull();
    // The recovery door is untouched by any of this
    expect((await h.as(session, 'GET', '/api/keys')).json<{ recovery_envelope: string }>().recovery_envelope).toBe(envelope('R'));
  });
});

describe('an invitation carrying the key (#212)', () => {
  it('the administrator attaches the envelope to a live invite; the invitee reads it back with the id', async () => {
    const h = await buildTestApp();
    const sam = await member(h, 'Sam', 'admin');
    const ann = await member(h, 'Ann');

    const { id: inviteId, path } = (await h.as(sam.cookie, 'POST', '/api/invites', {})).json<{ id: string; path: string }>();
    // No family key yet: nothing to wrap
    expect((await h.as(sam.cookie, 'PUT', `/api/invites/${inviteId}/envelope`, { envelope: envelope('V') })).statusCode).toBe(409);
    await createKey(h, sam.cookie);
    expect((await h.as(ann.cookie, 'PUT', `/api/invites/${inviteId}/envelope`, { envelope: envelope('V') })).statusCode).toBe(403);
    expect((await h.as(sam.cookie, 'PUT', `/api/invites/${inviteId}/envelope`, { envelope: RAW_KEY })).statusCode).toBe(400);
    expect((await h.as(sam.cookie, 'PUT', `/api/invites/${inviteId}/envelope`, { envelope: envelope('V') })).statusCode).toBe(200);

    const token = new URL(`http://x${path}`).searchParams.get('token')!;
    const check = (await h.app.inject({ method: 'GET', url: `/api/auth/invite?token=${token}` })).json<{ id: string; envelope: string }>();
    expect(check.id).toBe(inviteId);
    expect(check.envelope).toBe(envelope('V'));

    // A plain invite (from a device without the key) says so
    const { id: plain, path: plainPath } = (await h.as(sam.cookie, 'POST', '/api/invites', {})).json<{ id: string; path: string }>();
    const plainToken = new URL(`http://x${plainPath}`).searchParams.get('token')!;
    expect((await h.app.inject({ method: 'GET', url: `/api/auth/invite?token=${plainToken}` })).json<{ envelope: null }>().envelope).toBeNull();
    // A used invite cannot be given a key after the fact
    await h.app.inject({
      method: 'POST',
      url: '/api/auth/join',
      payload: { token: plainToken, name: 'Bob', email: 'bob@hub.local', auth_key: await authKey('bob password 123'), kdf_salt: SALT },
    });
    expect((await h.as(sam.cookie, 'PUT', `/api/invites/${plain}/envelope`, { envelope: envelope('W') })).statusCode).toBe(404);
  });
});

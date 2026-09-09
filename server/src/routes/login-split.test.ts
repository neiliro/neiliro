import { describe, expect, it } from 'vitest';
import { SALT, authKey, buildTestApp } from '../test-harness.js';
import { hashPassword } from '../lib/password.js';
import { KDF_SALT_PATTERN, deriveAuthKey } from '../lib/kdf.js';
import { id, now, runWithDb } from '../db/index.js';

/*
  The sign-in split (ADR 0001, #211): the browser sends a key derived from
  the password and the account's salt; the server hashes that. Accounts
  from before hold a hash of the password itself and cross over at their
  next sign-in.
*/

const EMAIL = 'sam@hub.local';
const PASSWORD = 'correct horse battery';
type Harness = Awaited<ReturnType<typeof buildTestApp>>;

/** An account exactly as the old code left it: scrypt of the password, no kdf_version, a migration-minted salt. */
async function legacyAccount(h: Harness) {
  const hash = await hashPassword(PASSWORD);
  return runWithDb(h.db, () => {
    const userId = id();
    h.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, kdf_salt, created_at) VALUES (?, ?, 'Sam', 'admin', ?, ?, ?)`,
      )
      .run(userId, EMAIL, hash, SALT, now());
    return userId;
  });
}

const kdfVersion = (h: Harness, userId: string) =>
  (h.db.prepare('SELECT kdf_version FROM users WHERE id = ?').get(userId) as { kdf_version: number | null })
    .kdf_version;

const prelogin = (h: Harness, email: string) =>
  h.app.inject({ method: 'POST', url: '/api/auth/prelogin', payload: { email } });
const login = (h: Harness, payload: Record<string, string>) =>
  h.app.inject({ method: 'POST', url: '/api/auth/login', payload });

describe('sign-in with a derived key', () => {
  it('a legacy account crosses over at its next sign-in and never sends the password again', async () => {
    const h = await buildTestApp();
    const userId = await legacyAccount(h);

    // The browser asks which secret to send, and with which salt
    const pre = await prelogin(h, EMAIL);
    expect(pre.json()).toEqual({ kdf: 'legacy', salt: SALT });
    const key = await deriveAuthKey(PASSWORD, pre.json().salt);

    // The key alone opens nothing yet: the stored hash is of the password
    expect((await login(h, { email: EMAIL, auth_key: key })).statusCode).toBe(401);

    // Password plus key: verified the old way, stored the new way
    expect((await login(h, { email: EMAIL, auth_key: key, password: PASSWORD })).statusCode).toBe(200);
    expect(kdfVersion(h, userId)).toBe(1);
    expect((await prelogin(h, EMAIL)).json()).toEqual({ kdf: 'v1', salt: SALT });

    // From now on the key signs in and the password is just a string that does not
    expect((await login(h, { email: EMAIL, auth_key: key })).statusCode).toBe(200);
    const withPassword = await login(h, {
      email: EMAIL,
      auth_key: await authKey('some other secret'),
      password: PASSWORD,
    });
    expect(withPassword.statusCode).toBe(401);
  });

  it('a wrong password does not cross a legacy account over', async () => {
    const h = await buildTestApp();
    const userId = await legacyAccount(h);
    const res = await login(h, { email: EMAIL, auth_key: await authKey('wrong'), password: 'wrong password here' });
    expect(res.statusCode).toBe(401);
    expect(kdfVersion(h, userId)).toBeNull();
  });

  it('answers an unknown address like a migrated one, with a salt that does not change', async () => {
    const h = await buildTestApp();
    const first = await prelogin(h, 'nobody@hub.local');
    expect(first.json().kdf).toBe('v1');
    expect(first.json().salt).toMatch(KDF_SALT_PATTERN);
    // Stable: asking twice tells nothing; another address, another decoy
    expect((await prelogin(h, 'Nobody@hub.local ')).json().salt).toBe(first.json().salt);
    expect((await prelogin(h, 'somebody@hub.local')).json().salt).not.toBe(first.json().salt);

    const res = await login(h, {
      email: 'nobody@hub.local',
      auth_key: await deriveAuthKey('whatever it is', first.json().salt),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Wrong login or password');
  });

  it('mints a salt for an account that never had one, and keeps it', async () => {
    const h = await buildTestApp();
    // The harness inserts users the way the demo seeder does: no salt
    h.join('nosalt');
    const a = await prelogin(h, 'nosalt@hub.local');
    expect(a.json().salt).toMatch(KDF_SALT_PATTERN);
    expect((await prelogin(h, 'nosalt@hub.local')).json().salt).toBe(a.json().salt);
  });

  it('refuses anything that is not a 32-byte key on the wire', async () => {
    const h = await buildTestApp();
    expect((await login(h, { email: EMAIL, auth_key: 'correct horse battery' })).statusCode).toBe(400);
  });

  it('a temporary password issued by the server signs in through the browser derivation', async () => {
    const h = await buildTestApp();
    const admin = h.join('admin');
    const dana = h.join('dana');

    const reset = await h.as(admin.cookie, 'POST', `/api/users/${dana.userId}/reset-password`, {});
    expect(reset.statusCode).toBe(200);
    const temp = reset.json<{ password: string }>().password;
    expect(kdfVersion(h, dana.userId)).toBe(1);

    // Dana's browser asks for the salt, derives from the same password — and gets in
    const pre = await prelogin(h, 'dana@hub.local');
    expect(pre.json().kdf).toBe('v1');
    const res = await login(h, { email: 'dana@hub.local', auth_key: await deriveAuthKey(temp, pre.json().salt) });
    expect(res.statusCode).toBe(200);
    expect(res.json().must_change_password).toBe(1);
  });

  it('a legacy session changes its password the old way once, then holds a derived hash', async () => {
    const h = await buildTestApp();
    const userId = await legacyAccount(h);
    const { createSession } = await import('../lib/auth.js');
    const cookie = runWithDb(h.db, () => createSession(userId, 'old-device'));

    const wrongProof = await h.as(cookie, 'POST', '/api/auth/change-password', {
      current_auth_key: await authKey(PASSWORD),
      new_auth_key: await authKey('a brand new passphrase'),
    });
    // Without the password the legacy hash cannot be checked
    expect(wrongProof.statusCode).toBe(400);
    expect(kdfVersion(h, userId)).toBeNull();

    const changed = await h.as(cookie, 'POST', '/api/auth/change-password', {
      current_auth_key: await authKey(PASSWORD),
      new_auth_key: await authKey('a brand new passphrase'),
      current_password: PASSWORD,
    });
    expect(changed.statusCode).toBe(200);
    expect(kdfVersion(h, userId)).toBe(1);

    expect((await login(h, { email: EMAIL, auth_key: await authKey('a brand new passphrase') })).statusCode).toBe(200);
  });
});

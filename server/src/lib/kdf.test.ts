import { describe, expect, it } from 'vitest';
import { AUTH_KEY_PATTERN, KDF_SALT_PATTERN, decoySalt, deriveAuthKey, newKdfSalt } from './kdf.js';

/*
  The vectors are copied from web/src/lib/crypto/crypto.test.ts. They are
  the contract: the browser sends this exact string for this password and
  salt, and a temporary password issued by the server must hash to the
  same thing the browser will later derive.
*/
const SALT = '00112233445566778899aabbccddeeff';

describe('kdf twin', () => {
  it('matches the browser at the fast iteration count', async () => {
    expect(await deriveAuthKey('correct horse battery', SALT, 1_000)).toBe('Bz_PEeh-49Gg0LfD7432rTJ_6tsq1phgwcuEv6sWIZM');
  });

  it('matches the browser at the production iteration count', async () => {
    const key = await deriveAuthKey('correct horse battery', SALT);
    expect(key).toBe('i1Af0j5K2J0yNEheyxajiiiJIJ_ohWSTznR5_HjRyNk');
    expect(key).toMatch(AUTH_KEY_PATTERN);
  }, 30_000);

  it('mints salts and refuses to derive with anything else', async () => {
    expect(newKdfSalt()).toMatch(KDF_SALT_PATTERN);
    await expect(deriveAuthKey('x', 'not a salt')).rejects.toThrow(/Not a KDF salt/);
  });

  it('decoy salts are stable per address and secret, and look like real ones', () => {
    const a = decoySalt('secret-one', 'Nobody@Example.test');
    expect(a).toMatch(KDF_SALT_PATTERN);
    expect(decoySalt('secret-one', 'nobody@example.test ')).toBe(a);
    expect(decoySalt('secret-two', 'nobody@example.test')).not.toBe(a);
    expect(decoySalt('secret-one', 'somebody@example.test')).not.toBe(a);
  });
});

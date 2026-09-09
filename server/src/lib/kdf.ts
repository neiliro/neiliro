import { createHash, hkdfSync, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

/*
  The server twin of web/src/lib/crypto/kdf.ts — same algorithm, same
  constants, same test vectors (ADR 0001, #211).

  The browser turns a password into an auth key and sends that instead of
  the password. The server never needs to run this for a sign-in: it
  scrypt-hashes whatever auth key arrives, as it hashed passwords before.
  It needs it in exactly one situation — when the server itself picks a
  temporary password (admin-reset, an administrator resetting a member) and
  must store the hash the person's browser will later produce from it.

  If this and the web module ever disagree, nobody can sign in. That is
  what the frozen vectors in kdf.test.ts are for; change both or neither.
*/

export const KDF_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const AUTH_INFO = 'neiliro/auth/v1';
const DECOY_DOMAIN = 'neiliro/kdf-decoy/v1';

const pbkdf2Async = promisify(pbkdf2);

/** What a salt looks like: 16 bytes as 32 lowercase hex characters. */
export const KDF_SALT_PATTERN = /^[0-9a-f]{32}$/;
/** What an auth key looks like on the wire: 32 bytes as 43 base64url characters. */
export const AUTH_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newKdfSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The salt handed out for an address that has no account here. Stable per
 * address and per family, so it cannot be told from a real one by asking
 * twice, and different across families, so one family's decoys say
 * nothing about another's.
 */
export function decoySalt(secret: string, email: string): string {
  return createHash('sha256')
    .update(DECOY_DOMAIN)
    .update(secret)
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

export async function deriveAuthKey(
  password: string,
  saltHex: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  if (!KDF_SALT_PATTERN.test(saltHex)) throw new Error('Not a KDF salt');
  const master = await pbkdf2Async(
    password.normalize('NFKC'),
    Buffer.from(saltHex, 'hex'),
    iterations,
    32,
    'sha256',
  );
  const authKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), AUTH_INFO, 32));
  master.fill(0);
  return authKey.toString('base64url');
}

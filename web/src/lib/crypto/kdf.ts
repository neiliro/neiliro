import { fromBase64url, randomBytes, toBase64url, utf8, type Bytes } from './encoding';

/*
  From one password, two keys that cannot be turned into each other
  (ADR 0001, #211).

  Today the password travels to the server and is verified there. If the
  same password also unlocked the family key, the server would hold enough
  at login time to read everything. So the browser stretches the password
  once, then splits the result with HKDF:

    master  = PBKDF2-SHA256(password, salt, 600 000)
    authKey = HKDF(master, info "neiliro/auth/v1")   → sent instead of the password
    wrapKey = HKDF(master, info "neiliro/wrap/v1")   → never leaves the browser

  HKDF is a one-way expansion: knowing authKey says nothing about wrapKey.
  The server scrypt-hashes authKey exactly as it hashed the password, so a
  database leak still yields no credential.

  Decisions worth defending:

  - PBKDF2 rather than Argon2. Argon2 in a browser is WASM, and WASM needs
    a hole in the strict CSP (`'wasm-unsafe-eval'`) plus a dependency to
    audit. PBKDF2-SHA256 at OWASP's 600 000 iterations is native WebCrypto,
    zero bytes of bundle, and what Bitwarden ships by default. The version
    tag below exists so this can change without guessing later.
  - The salt is a random value per account, chosen by the browser that
    creates the account and stored on the server, which hands it back at
    sign-in (/api/auth/prelogin). Not the login address: an administrator
    can change a member's address, and a key derived from the address
    would die with it — the member could never sign in again. A salt is
    public by definition; the server answering with one is not a leak. For
    an address it does not know, the server answers a salt derived from a
    per-family secret and the address, so an unknown account and a real
    one look exactly the same from outside.
*/

export const KDF_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const AUTH_INFO = 'neiliro/auth/v1';
const WRAP_INFO = 'neiliro/wrap/v1';
const SALT_BYTES = 16;

/** A salt for a new account: 16 random bytes as 32 hex characters. */
export function newKdfSalt(): string {
  return Array.from(randomBytes(SALT_BYTES), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function saltFromHex(hex: string): Bytes {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('Not a KDF salt');
  const out = new Uint8Array(SALT_BYTES);
  for (let i = 0; i < SALT_BYTES; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hkdfBits(master: Bytes, info: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export interface CredentialKeys {
  /** Sent to the server in place of the password; base64url of 32 bytes. */
  authKey: string;
  /** Opens this member's key envelope; stays in the browser. */
  wrapKey: CryptoKey;
  kdfVersion: number;
}

/**
 * The one slow step at sign-in and account creation. `iterations` is a
 * parameter only so tests can run the algorithm quickly; production callers
 * never pass it.
 */
export async function deriveCredentialKeys(
  password: string,
  salt: Bytes,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CredentialKeys> {
  // NFKC like the server's legacy scrypt path: a password typed through
  // two keyboards must be one password
  const pw = await crypto.subtle.importKey('raw', utf8(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const master = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256),
  );
  const authKey = toBase64url(await hkdfBits(master, AUTH_INFO));
  const wrapKey = await importWrapKey(await hkdfBits(master, WRAP_INFO));
  master.fill(0);
  return { authKey, wrapKey, kdfVersion: KDF_VERSION };
}

/**
 * A wrap key from 32 bytes of key material. Non-extractable: nothing in
 * the page can read it back, only use it. Shared with the recovery code
 * (recovery.ts), which is key material of full entropy and skips PBKDF2.
 */
export async function importWrapKey(material: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ]);
}

/** Derived wrap-key material for a full-entropy secret (recovery codes). */
export async function expandSecret(secret: Bytes, info: string): Promise<Bytes> {
  return hkdfBits(secret, info);
}

export const authKeyBytes = (authKey: string): Bytes => fromBase64url(authKey);

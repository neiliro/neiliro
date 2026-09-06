import { concat, fromBase64url, toBase64url, utf8, type Bytes } from './encoding';

/*
  From one password, two keys that cannot be turned into each other
  (ADR 0001, #211).

  Today the password travels to the server and is verified there. If the
  same password also unlocked the family key, the server would hold enough
  at login time to read everything. So the browser stretches the password
  once, then splits the result with HKDF:

    master  = PBKDF2-SHA256(password, salt(email), 600 000)
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
  - The salt is derived from the login address, not handed out by the
    server. A per-user salt fetched before login is a pre-login endpoint,
    and a pre-login endpoint that answers differently for existing and
    unknown addresses is an account oracle — the thing the password reset
    goes to lengths to avoid. The address is unique per hub and the domain
    string keeps the result specific to Neiliro; with 600 000 iterations a
    precomputed table per address is not a realistic attack.
  - The address is normalised the way the server normalises it (trim +
    lowercase, see emailField in routes/setup.ts). A change on one side
    silently locks everyone out — the test vectors are there to catch it.
*/

export const KDF_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
const SALT_DOMAIN = 'neiliro/kdf-salt/v1';
const AUTH_INFO = 'neiliro/auth/v1';
const WRAP_INFO = 'neiliro/wrap/v1';

export function normalizeLogin(email: string): string {
  return email.trim().toLowerCase();
}

async function saltFor(email: string): Promise<Bytes> {
  const digest = await crypto.subtle.digest('SHA-256', concat(utf8(SALT_DOMAIN), utf8(normalizeLogin(email))));
  return new Uint8Array(digest);
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
  email: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<CredentialKeys> {
  const salt = await saltFor(email);
  const pw = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
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

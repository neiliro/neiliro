import { fromBase64url, fromUtf8, randomBytes, toBase64url, utf8, type Bytes } from './encoding';

/*
  The field envelope — what an encrypted column value looks like (#214).

    e1:<base64url nonce>:<base64url ciphertext+tag>

  - `e1` is the format version. A future algorithm is `e2`, and a reader
    that meets an unknown prefix fails loudly rather than guessing.
  - AES-256-GCM, 96-bit random nonce per value. The family key encrypts a
    few million values over its life at most, far below the nonce-collision
    horizon; still, never reuse a nonce by construction — always fresh.
  - Additional authenticated data binds the ciphertext to its place:
    table, column and row id. Someone editing the database cannot move a
    note body into another note, or a transaction comment into a title,
    without the decryption failing. The AAD is not stored — both sides
    know where the value lives.

  A value without the prefix is plaintext from before its module was
  migrated (ADR 0001, rollout). `readField` passes it through; the first
  edit rewrites it encrypted. `isEncrypted` is how the UI knows which.
*/

export const FIELD_PREFIX = 'e1:';
const NONCE_BYTES = 12;

export interface FieldPlace {
  table: string;
  column: string;
  id: string;
}

export function fieldAad(place: FieldPlace): Bytes {
  // Slash-joined: ids are ULID-like and columns are identifiers, neither
  // contains a slash, so the encoding is unambiguous.
  return utf8(`${place.table}/${place.column}/${place.id}`);
}

/** An envelope of either kind: sealed in the browser (`e1:`) or to the family public key (`s1:`, #223). */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && (value.startsWith(FIELD_PREFIX) || value.startsWith('s1:'));
}

export async function encryptField(key: CryptoKey, plaintext: string, place: FieldPlace): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: fieldAad(place) },
    key,
    utf8(plaintext),
  );
  return `${FIELD_PREFIX}${toBase64url(nonce)}:${toBase64url(new Uint8Array(ct))}`;
}

export class EnvelopeError extends Error {}

export async function decryptField(key: CryptoKey, value: string, place: FieldPlace): Promise<string> {
  if (!value.startsWith(FIELD_PREFIX)) throw new EnvelopeError('Not an encrypted field');
  const parts = value.slice(FIELD_PREFIX.length).split(':');
  if (parts.length !== 2) throw new EnvelopeError('Malformed envelope');
  const nonce = fromBase64url(parts[0]!);
  if (nonce.length !== NONCE_BYTES) throw new EnvelopeError('Malformed envelope');
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: fieldAad(place) },
      key,
      fromBase64url(parts[1]!),
    );
    return fromUtf8(new Uint8Array(pt));
  } catch {
    // WebCrypto says only "OperationError" — a wrong key, a moved value
    // and a corrupted byte all look the same, on purpose.
    throw new EnvelopeError('Cannot decrypt this value here');
  }
}

/**
 * What a module reads: encrypted values are opened, legacy plaintext
 * passes through, null stays null.
 */
export async function readField(
  key: CryptoKey,
  value: string | null,
  place: FieldPlace,
): Promise<string | null> {
  if (value === null) return null;
  return isEncrypted(value) ? decryptField(key, value, place) : value;
}

/*
  Key wrapping shares the envelope shape with a different prefix, so a
  wrapped key never parses as a field and vice versa:

    w1:<base64url nonce>:<base64url wrapped key>

  The AAD names what the envelope is for (`kind` and `owner`, see #210):
  a member's envelope cannot be re-labelled as another member's.
*/
export const WRAP_PREFIX = 'w1:';

export interface WrapPlace {
  kind: string;
  owner: string;
}

const wrapAad = (place: WrapPlace): Bytes => utf8(`envelope/${place.kind}/${place.owner}`);

export async function wrapFamilyKey(familyKey: CryptoKey, wrapKey: CryptoKey, place: WrapPlace): Promise<string> {
  const nonce = randomBytes(NONCE_BYTES);
  const wrapped = await crypto.subtle.wrapKey('raw', familyKey, wrapKey, {
    name: 'AES-GCM',
    iv: nonce,
    additionalData: wrapAad(place),
  });
  return `${WRAP_PREFIX}${toBase64url(nonce)}:${toBase64url(new Uint8Array(wrapped))}`;
}

export async function unwrapFamilyKey(envelope: string, wrapKey: CryptoKey, place: WrapPlace): Promise<CryptoKey> {
  if (!envelope.startsWith(WRAP_PREFIX)) throw new EnvelopeError('Not a key envelope');
  const parts = envelope.slice(WRAP_PREFIX.length).split(':');
  if (parts.length !== 2) throw new EnvelopeError('Malformed envelope');
  const nonce = fromBase64url(parts[0]!);
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      fromBase64url(parts[1]!),
      wrapKey,
      { name: 'AES-GCM', iv: nonce, additionalData: wrapAad(place) },
      { name: 'AES-GCM', length: 256 },
      // Extractable on purpose: the member who invites or re-admits
      // someone must be able to wrap this key for them, and wrapKey()
      // refuses a non-extractable source. Non-extractable would buy little
      // anyway — a script that can use the key can decrypt everything.
      true,
      FAMILY_KEY_USAGES,
    );
  } catch (err) {
    if (err instanceof EnvelopeError) throw err;
    throw new EnvelopeError('This envelope does not open with that key');
  }
}

export const FAMILY_KEY_USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

/** A fresh family key — generated once, in the browser of whoever sets the hub up. */
export async function generateFamilyKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, FAMILY_KEY_USAGES);
}

/** Only for tests and the export path: the raw bytes of a family key. */
export async function exportFamilyKey(key: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function importFamilyKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== 32) throw new EnvelopeError('A family key is 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, FAMILY_KEY_USAGES);
}

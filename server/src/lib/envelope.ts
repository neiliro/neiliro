import { webcrypto } from 'node:crypto';
import { isCiphertext } from './ciphertext.js';

/*
  Opening a field envelope on the server — in exactly one situation.

  The rule of ADR 0001 is that the server never holds the family key. The
  two token surfaces that feed other people's software break it knowingly
  and narrowly (#218): a calendar app polling the subscription URL and a
  guest opening a shared event expect readable text, and the person who
  made the link chose to hand those events on. So the link carries the key
  after the token (`<token>~<key>`), the server imports it for the
  duration of that request, opens the fields the response needs, and keeps
  nothing — the key is never written, logged or cached. The token part is
  stored as before; the key part exists only in the link the family holds.

  The format is the browser's (web/src/lib/crypto/envelope.ts): AES-256-GCM,
  `e1:<nonce>:<ciphertext>` in base64url, additional data `table/column/id`.
*/

const FIELD_PREFIX = 'e1:';
const KEY_SEPARATOR = '~';

/*
  Sealing (#223) — the one place the server encrypts. Incoming mail arrives
  as plaintext MIME and the server has no family key; it has the family's
  X25519 public half (family_key.public_key) and seals to that, once,
  before anything is written: an ephemeral pair, a shared secret, HKDF,
  AES-256-GCM. The browser derives the private half from the family key
  and opens it (web/src/lib/crypto/seal.ts — the two must agree byte for
  byte, and that file's test pins the construction).

    s1:<ephemeral public key>:<nonce>:<ciphertext>      a field
    "NS1" || ephemeral public key (32) || NE1 file      a file
*/
const SEALED_PREFIX = 's1:';
const SEALED_FILE_MAGIC = Buffer.from('NS1');
const SEAL_INFO = 'neiliro/seal/v1';
const CHUNK = 1024 * 1024;

const b64 = (b: Uint8Array | ArrayBuffer): string => Buffer.from(b as ArrayBuffer).toString('base64url');

async function sealKeyFor(familyPubB64: string): Promise<{ ephemeralPub: Buffer; key: webcrypto.CryptoKey }> {
  const familyPub = Buffer.from(familyPubB64, 'base64url');
  if (familyPub.length !== 32) throw new Error('The family public key is 32 bytes');
  const ephemeral = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  const recipient = await webcrypto.subtle.importKey('raw', familyPub, { name: 'X25519' }, false, []);
  const shared = await webcrypto.subtle.deriveBits({ name: 'X25519', public: recipient }, ephemeral.privateKey, 256);
  const ephemeralPub = Buffer.from(await webcrypto.subtle.exportKey('raw', ephemeral.publicKey));
  const hkdf = await webcrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: Buffer.concat([ephemeralPub, familyPub]), info: Buffer.from(SEAL_INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  return { ephemeralPub, key };
}

/** A text value the server received in the clear, sealed to the family public key in its place. */
export async function sealField(familyPubB64: string, plaintext: string, place: FieldPlace): Promise<string> {
  const { ephemeralPub, key } = await sealKeyFor(familyPubB64);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(`${place.table}/${place.column}/${place.id}`) },
    key,
    Buffer.from(plaintext, 'utf8'),
  );
  return `${SEALED_PREFIX}${b64(ephemeralPub)}:${b64(nonce)}:${b64(ct)}`;
}

/*
  The NE1 file envelope (web/src/lib/crypto/files.ts), written here under a
  sealing key: header "NE1" || chunkSize(4) || noncePrefix(8), then AES-GCM
  chunks with nonce = prefix || counter and AAD "file/<id>/<index>/<last|more>".
*/
async function encryptFileBytes(key: webcrypto.CryptoKey, plain: Buffer, fileId: string): Promise<Buffer> {
  const prefix = Buffer.from(webcrypto.getRandomValues(new Uint8Array(8)));
  const header = Buffer.alloc(3 + 4 + 8);
  header.write('NE1', 0);
  header.writeUInt32BE(CHUNK, 3);
  prefix.copy(header, 7);
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  const parts: Buffer[] = [header];
  for (let i = 0; i < count; i++) {
    const nonce = Buffer.alloc(12);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(i, 8);
    const slice = plain.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, plain.length));
    const ct = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(`file/${fileId}/${i}/${i === count - 1 ? 'last' : 'more'}`) },
      key,
      slice,
    );
    parts.push(Buffer.from(ct));
  }
  return Buffer.concat(parts);
}

/** A file the server received in the clear, sealed to the family public key under its attachment id. */
export async function sealFile(familyPubB64: string, plain: Buffer, fileId: string): Promise<Buffer> {
  const { ephemeralPub, key } = await sealKeyFor(familyPubB64);
  return Buffer.concat([SEALED_FILE_MAGIC, ephemeralPub, await encryptFileBytes(key, plain, fileId)]);
}

export interface FieldPlace {
  table: string;
  column: string;
  id: string;
}

/** What an encrypted value reads as when the link carries no key. */
export const LOCKED_TEXT = '••••••';

/** Split `<token>~<key>`; a token from before the key has no second half. */
export function splitTokenKey(raw: string): { token: string; key: Buffer | null } {
  const at = raw.indexOf(KEY_SEPARATOR);
  if (at < 0) return { token: raw, key: null };
  const key = Buffer.from(raw.slice(at + 1), 'base64url');
  return { token: raw.slice(0, at), key: key.length === 32 ? key : null };
}

export class FieldOpener {
  private key: Promise<webcrypto.CryptoKey> | null;

  constructor(raw: Buffer | null) {
    this.key = raw
      ? webcrypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      : null;
  }

  /** Plaintext passes through; an envelope opens, or reads as the placeholder. */
  async open(value: string | null, place: FieldPlace): Promise<string | null> {
    if (value === null || !isCiphertext(value)) return value;
    if (!this.key) return LOCKED_TEXT;
    const parts = value.slice(FIELD_PREFIX.length).split(':');
    if (parts.length !== 2) return LOCKED_TEXT;
    try {
      const pt = await webcrypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: Buffer.from(parts[0]!, 'base64url'),
          additionalData: Buffer.from(`${place.table}/${place.column}/${place.id}`, 'utf8'),
        },
        await this.key,
        Buffer.from(parts[1]!, 'base64url'),
      );
      return Buffer.from(pt).toString('utf8');
    } catch {
      // A wrong key and a moved value look alike, on purpose; neither is an error page
      return LOCKED_TEXT;
    }
  }

  /** The columns a feed shows, opened under the row's own id. */
  async openRow<T extends { id: string }>(table: string, row: T, columns: (keyof T & string)[]): Promise<T> {
    const out = { ...row };
    for (const column of columns) {
      const value = row[column];
      if (typeof value !== 'string') continue;
      (out as Record<string, unknown>)[column] = await this.open(value, { table, column, id: row.id });
    }
    return out;
  }
}

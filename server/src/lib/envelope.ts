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

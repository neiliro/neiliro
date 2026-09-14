import { createCipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isCiphertext } from './ciphertext.js';
import { excerptOf } from './excerpt.js';

/*
  The demo's key (ADR 0001, #225).

  A sandbox is a real hub: the browser seals what the guest writes and
  opens what it reads with a family key. The seeded sample family has to be
  readable through that same path — so at hand-out the server mints a key
  for the guest, rewrites the copied template's words into the browser's
  own `e1:` envelopes under it, and holds the key next to the sandbox for
  as long as the sandbox lives. GET /api/keys returns it to the guest's
  browser, which stores it exactly like a family key it unwrapped itself.

  This is the one place the server writes `e1:` — demo data is public by
  definition, and the server knowing it is fine. There is deliberately no
  "plaintext mode" for the demo: that flag would be the path real data ends
  up on a year from now. The constructions here mirror the browser byte for
  byte (web/src/lib/crypto/envelope.ts, x25519.ts); demo-key.test.ts pins
  both with fixed vectors.
*/

/** The same list as web/src/lib/crypto/field-map.ts ENCRYPTED_FIELDS; the test insists on it. */
export const DEMO_ENCRYPTED_FIELDS: Record<string, readonly string[]> = {
  notes: ['title', 'body_md', 'excerpt'],
  note_versions: ['title', 'body_md'],
  note_links: ['target_title'],
  tasks: ['title', 'description'],
  projects: ['title', 'description'],
  events: ['title', 'description', 'location'],
  calendars: ['name'],
  accounts: ['name'],
  categories: ['name'],
  transactions: ['note', 'place'],
  recurring_transactions: ['title', 'note', 'place'],
  reconciliations: ['note'],
  lists: ['title'],
  list_items: ['title'],
  list_sections: ['title'],
  profile_entries: ['label', 'value'],
  attachments: ['filename'],
  mail_messages: ['from_address', 'from_name', 'to_address', 'subject', 'body_text', 'body_html'],
};

/*
  What the browser names a row in the envelope's additional data
  (lib/codec.ts): its own id, except for the rows that have none of their
  own. A note version is the note's own ciphertext copied at snapshot time
  and stays under the note's name; a link row is bound to its source note;
  a reconciliation note to `<account_id>@<checked_on>`.
*/
const ROW_NAME: Record<string, { table: string; id: string }> = {
  note_versions: { table: 'notes', id: 'note_id' },
  note_links: { table: 'note_links', id: 'source_note_id' },
  reconciliations: { table: 'reconciliations', id: "account_id || '@' || checked_on" },
};

const FIELD_PREFIX = 'e1:';
const X25519_INFO = 'neiliro/x25519/v1';
// SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 }, OCTET STRING { OCTET STRING <32 bytes> } }
const PKCS8_X25519_PREFIX = Buffer.from('MC4CAQAwBQYDK2VuBCIEIA', 'base64url');

export interface FieldPlace {
  table: string;
  column: string;
  id: string;
}

/** A fresh 256-bit key, the same shape the browser generates for a family. */
export const generateGuestKey = (): Buffer => randomBytes(32);

/** The public half of the X25519 pair the browser derives from this key — what family_key.public_key holds. */
export function guestPublicKey(raw: Buffer): string {
  const seed = Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), X25519_INFO, 32));
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(priv).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('X25519 export without a public point');
  return jwk.x;
}

/** A field envelope in the browser's format: AES-256-GCM, `e1:<nonce>:<ciphertext||tag>`, AAD `table/column/id`. */
export function encryptField(raw: Buffer, plaintext: string, place: FieldPlace): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', raw, nonce);
  cipher.setAAD(Buffer.from(`${place.table}/${place.column}/${place.id}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${FIELD_PREFIX}${nonce.toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * Rewrite every word of a freshly copied sandbox under the guest's key and
 * record the key's public half, so the browser finds a family that has a
 * key and rows it can open. Plaintext that is already ciphertext is left
 * alone; a table the template does not have is skipped.
 */
export function encryptSandbox(db: Database.Database, raw: Buffer, createdBy: string, now: string): void {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
  );
  const run = db.transaction(() => {
    for (const [table, columns] of Object.entries(DEMO_ENCRYPTED_FIELDS)) {
      if (!tables.has(table)) continue;
      const name = ROW_NAME[table] ?? { table, id: 'id' };
      const rows = db
        .prepare(`SELECT rowid AS rowid_, ${name.id} AS name_, ${columns.join(', ')} FROM ${table}`)
        .all() as Record<string, unknown>[];
      const update = db.prepare(`UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE rowid = ?`);
      for (const row of rows) {
        const rowName = String(row['name_']);
        const values = columns.map((column) => {
          const value = row[column];
          if (typeof value !== 'string' || isCiphertext(value)) return value;
          return encryptField(raw, value, { table: name.table, column, id: rowName });
        });
        // The list preview the browser would have written alongside the body
        if (table === 'notes') {
          const body = row['body_md'];
          const at = columns.indexOf('excerpt');
          if (typeof body === 'string' && !isCiphertext(body) && row['excerpt'] == null && at >= 0) {
            values[at] = encryptField(raw, excerptOf(body), { table, column: 'excerpt', id: rowName });
          }
        }
        update.run(...values, row['rowid_']);
      }
    }
    db.prepare(`INSERT INTO family_key (id, public_key, created_by, created_at) VALUES (1, ?, ?, ?)`).run(
      guestPublicKey(raw),
      createdBy,
      now,
    );
  });
  run();
}

import { db, id, now } from '../db/index.js';

/*
  The server's side of the family key (ADR 0001, #210): it stores envelopes
  it cannot open and knows which doors a member still has. Every value that
  arrives here is a wrapped key in the `w1:` format the browser produces
  (web/src/lib/crypto/envelope.ts): a 12-byte nonce and 48 bytes of
  ciphertext, base64url. The shape is pinned so nothing else can be stored
  in these columns — a raw 32-byte key is 43 characters and does not match.
*/
export const ENVELOPE_PATTERN = /^w1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{64}$/;
/** An X25519 public key: 32 bytes as base64url. */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A handoff link is one-shot in spirit and a week in practice, like an invite. */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60_000;

export type EnvelopeKind = 'password' | 'recovery' | 'handoff';

export interface FamilyKeyRow {
  public_key: string;
  created_at: string;
}

export function familyKey(): FamilyKeyRow | null {
  return (
    (db.prepare('SELECT public_key, created_at FROM family_key WHERE id = 1').get() as
      | FamilyKeyRow
      | undefined) ?? null
  );
}

/** The member's live envelope of one kind, or null. */
export function liveEnvelope(userId: string | null, kind: EnvelopeKind): string | null {
  const row = db
    .prepare(
      `SELECT envelope FROM key_envelopes
        WHERE ${userId === null ? 'user_id IS NULL' : 'user_id = ?'} AND kind = ? AND retired_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...(userId === null ? [kind] : [userId, kind])) as { envelope: string } | undefined;
  return row?.envelope ?? null;
}

/**
 * A member "holds the key" as far as the server can tell when they have a
 * live password envelope: the server cannot check the key itself, and this
 * is the one proxy that does not require trusting the request. It gates
 * the actions that hand the key on (handoff, a new recovery code).
 */
export function holdsKey(userId: string): boolean {
  return liveEnvelope(userId, 'password') !== null;
}

export function retireEnvelopes(userId: string | null, kind: EnvelopeKind): number {
  return db
    .prepare(
      `UPDATE key_envelopes SET retired_at = ?
        WHERE ${userId === null ? 'user_id IS NULL' : 'user_id = ?'} AND kind = ? AND retired_at IS NULL`,
    )
    .run(...(userId === null ? [now(), kind] : [now(), userId, kind])).changes;
}

/**
 * A new password the member's browser never derived a wrap key from — a
 * reset by the administrator, by e-mail, or by admin-reset.mjs — cannot
 * open the envelope wrapped under the old one. The envelope is retired so
 * the member is offered the other doors (re-admission, the recovery code)
 * instead of an envelope that silently fails to open. Callers run this
 * inside the transaction that changes the password.
 */
export function retirePasswordEnvelope(userId: string): void {
  retireEnvelopes(userId, 'password');
}

export function storeEnvelope(
  userId: string | null,
  kind: EnvelopeKind,
  envelope: string,
  createdBy: string | null,
): string {
  const envelopeId = id();
  db.prepare(
    `INSERT INTO key_envelopes (id, user_id, kind, envelope, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(envelopeId, userId, kind, envelope, createdBy, now());
  return envelopeId;
}

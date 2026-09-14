import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentTenant, db, now } from '../db/index.js';
import { destroyAllSessions } from './auth.js';
import { log } from './log.js';

/*
  A member leaves for good (GDPR art. 17, right to erasure).

  The rule: remove everything only this person could see, keep what the
  family shares, and strip the person's words from the shared rows that
  must stay for the arithmetic. Concretely —

  Gone: private notes (with versions and files), personal calendars and
  their events, the profile (birthday, allergies, preferences, wishes) and
  the birthday event derived from it, sessions, reset and confirmation
  links, the key envelopes that let this account open the family key.

  Kept: shared notes, tasks, events, lists and letters they touched — a
  household's record does not lose the grocery run because the person who
  wrote it moved out. Their name on those rows becomes "Former member".

  Money is the careful part. A personal account's own transactions go;
  a transfer between the personal account and a shared one stays, because
  deleting it would move the shared account's balance — balances are
  computed, and a family must not find €200 missing because someone left.
  Such transfers keep the amount and lose the words. A personal account
  that nothing shared points at is removed; one that a kept transfer
  still references stays as an archived, nameless stub.

  The users row is a tombstone rather than a deletion: half the foreign
  keys are ON DELETE SET NULL, and owner_id → NULL would turn a personal
  account into a shared one. deleted_at marks it; lists skip it; the login
  is impossible (an address nobody can receive at, an unverifiable hash).
*/

const TOMBSTONE_NAME = 'Former member';

function personalAccountIds(userId: string): string[] {
  return (
    db.prepare('SELECT id FROM accounts WHERE owner_id = ? AND shared = 0').all(userId) as { id: string }[]
  ).map((r) => r.id);
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export async function eraseMember(userId: string): Promise<void> {
  const files: string[] = [];

  db.transaction(() => {
    const stamp = now();

    // Files must be collected before the rows cascade away
    for (const row of db
      .prepare(
        `SELECT a.storage_path FROM attachments a
           JOIN notes n ON n.id = a.note_id
          WHERE n.owner_id = ? AND n.visibility = 'private'`,
      )
      .all(userId) as { storage_path: string }[]) {
      files.push(row.storage_path);
    }

    // ── Notes: private ones go, shared ones stay with a nameless author
    db.prepare("DELETE FROM notes WHERE owner_id = ? AND visibility = 'private'").run(userId);
    db.prepare("UPDATE notes SET owner_id = NULL WHERE owner_id = ? AND visibility = 'shared'").run(userId);

    // ── Calendar: personal calendars go with their events; a shared
    //    calendar this person happened to own becomes the family's
    db.prepare('DELETE FROM calendars WHERE owner_id = ? AND shared = 0').run(userId);
    db.prepare('UPDATE calendars SET owner_id = NULL WHERE owner_id = ?').run(userId);
    db.prepare('DELETE FROM events WHERE profile_user_id = ?').run(userId);
    db.prepare('DELETE FROM event_participants WHERE user_id = ?').run(userId);

    // ── Money
    const personal = personalAccountIds(userId);
    if (personal.length > 0) {
      const inP = `IN (${placeholders(personal.length)})`;
      // Movements that touch only this person's accounts
      db.prepare(
        `DELETE FROM transactions
          WHERE account_id ${inP} AND (to_account_id IS NULL OR to_account_id ${inP})`,
      ).run(...personal, ...personal);
      // Transfers to or from a shared account stay for the shared balance; the words go
      for (const row of db
        .prepare(
          `SELECT a.storage_path FROM attachments a
             JOIN transactions t ON t.id = a.transaction_id
            WHERE t.account_id ${inP} OR t.to_account_id ${inP}`,
        )
        .all(...personal, ...personal) as { storage_path: string }[]) {
        files.push(row.storage_path);
      }
      db.prepare(
        `DELETE FROM attachments WHERE transaction_id IN
           (SELECT id FROM transactions WHERE account_id ${inP} OR to_account_id ${inP})`,
      ).run(...personal, ...personal);
      db.prepare(
        `UPDATE transactions SET note = NULL, place = NULL
          WHERE account_id ${inP} OR to_account_id ${inP}`,
      ).run(...personal, ...personal);
      db.prepare(`DELETE FROM recurring_transactions WHERE account_id ${inP} OR to_account_id ${inP}`).run(
        ...personal,
        ...personal,
      );
      db.prepare(`DELETE FROM reconciliations WHERE account_id ${inP}`).run(...personal);
      // An account nothing shared points at any more is simply gone
      db.prepare(
        `DELETE FROM accounts WHERE id ${inP}
           AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = accounts.id OR t.to_account_id = accounts.id)`,
      ).run(...personal);
      // The rest stay as archived stubs so the kept transfers have both ends
      db.prepare(`UPDATE accounts SET name = ?, archived_at = coalesce(archived_at, ?), updated_at = ? WHERE id ${inP}`).run(
        TOMBSTONE_NAME,
        stamp,
        stamp,
        ...personal,
      );
    }
    // A shared account this person owned on paper becomes the family's
    db.prepare('UPDATE accounts SET owner_id = NULL WHERE owner_id = ?').run(userId);

    // ── Profile: birthday, allergies, preferences, wishes — theirs alone
    db.prepare('DELETE FROM wishes WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM profile_entries WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM profiles WHERE user_id = ?').run(userId);

    // ── Tasks stay; the assignment does not
    db.prepare('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?').run(userId);

    // ── Credentials and doors
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM key_envelopes WHERE user_id = ?').run(userId);

    // ── The tombstone. The address is syntactically valid and unique but
    //    on a reserved TLD nobody can receive at; the hash verifies nothing.
    db.prepare(
      `UPDATE users SET
         name = ?, email = ?, password_hash = ?, color = color,
         google_sub = NULL, totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL,
         email_verified_at = NULL, calendar_feed_token = NULL, kdf_salt = NULL,
         password_login_disabled = 0, must_change_password = 0, last_login_at = NULL,
         disabled_at = coalesce(disabled_at, ?), deleted_at = ?
       WHERE id = ?`,
    ).run(
      TOMBSTONE_NAME,
      `deleted-${userId.slice(0, 8)}@removed.invalid`,
      `!erased:${randomBytes(16).toString('hex')}`,
      stamp,
      stamp,
      userId,
    );
  })();

  destroyAllSessions(userId);

  // Rows are gone; the bytes must follow, or the attachments directory
  // keeps what the database no longer knows about
  const dir = currentTenant().attachmentsDir;
  for (const path of files) {
    await unlink(resolve(dir, path)).catch(() => {});
  }
  log.notice(`member erased: ${userId} (${files.length} files removed)`);
}

/** Whether another administrator would remain if this one left. */
export function otherAdminsExist(userId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM users WHERE role = 'admin' AND id != ? AND deleted_at IS NULL AND disabled_at IS NULL")
      .get(userId),
  );
}

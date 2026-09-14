import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentTenant, db } from '../db/index.js';
import { log } from './log.js';

/*
  Letters leave the desk two ways: one at a time by hand, or by age.

  A household desk is not an archive. School letters and bills are handled
  and then they are clutter — and clutter that names people, so storage
  limitation (GDPR art. 5(1)(e)) is a household concern before it is a
  legal one. The administrator picks how long letters stay under
  Settings → Family mailbox (`mail.retention_days`, 0 = keep forever, the
  default: a family that never chose is not surprised by a disappearance),
  and a daily sweep removes what is older. Deleting a letter takes its
  replies and its files with it; the task made from a letter stays — it
  carries its own copy of the excerpt and belongs to the board, not to the
  mailbox.
*/

export const RETENTION_KEY = 'mail.retention_days';

/** The family's choice: days to keep an incoming letter, or 0 for forever. */
export function retentionDays(): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(RETENTION_KEY) as { value: string } | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Removes a letter, its replies and every file attached to them. Returns false when there is no such letter. */
export async function deleteMessage(messageId: string): Promise<boolean> {
  const files = db.transaction((): string[] | null => {
    const exists = db.prepare('SELECT 1 FROM mail_messages WHERE id = ?').get(messageId);
    if (!exists) return null;
    const paths = (
      db
        .prepare(
          `SELECT storage_path FROM attachments
            WHERE mail_message_id = ? OR mail_message_id IN (SELECT id FROM mail_messages WHERE in_reply_to = ?)`,
        )
        .all(messageId, messageId) as { storage_path: string }[]
    ).map((r) => r.storage_path);
    // Replies are half a conversation without the letter they answer
    db.prepare('DELETE FROM mail_messages WHERE in_reply_to = ?').run(messageId);
    db.prepare('DELETE FROM mail_messages WHERE id = ?').run(messageId);
    return paths;
  })();
  if (files === null) return false;
  const dir = currentTenant().attachmentsDir;
  for (const path of files) await unlink(resolve(dir, path)).catch(() => {});
  return true;
}

/** One pass of the age rule for the current family. Returns how many letters went. */
export async function sweepMailRetention(nowMs = Date.now()): Promise<number> {
  const days = retentionDays();
  if (days === 0) return 0;
  // received_at is written by db now(), which is UTC in the same shape; a
  // day of slack either way is fine for a rule counted in months
  const stamp = new Date(nowMs - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const old = db
    .prepare("SELECT id FROM mail_messages WHERE kind = 'in' AND received_at < ?")
    .all(stamp) as { id: string }[];
  let removed = 0;
  for (const { id } of old) {
    if (await deleteMessage(id)) removed += 1;
  }
  if (removed > 0) log.notice(`mail: ${removed} letters older than ${days} days removed`);
  return removed;
}

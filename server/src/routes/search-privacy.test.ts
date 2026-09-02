import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { runWithDb, id, now } from '../db/index.js';

/*
  Attachment privacy has to hold in global search too (#184).

  Privacy in this hub is enforced in three places that must agree — the
  list, the search, and a direct fetch by id — and search was the one that
  disagreed. An attachment inherits the privacy of whatever it hangs on,
  but a receipt on a personal money account hangs on a transaction, not a
  note, so `note_id IS NULL` is true for it. A guard that only consulted
  the note clause therefore let the filenames of another member's
  receipts through: hidden on the money screens, refused on a direct
  fetch, and listed in search results.

  The bytes were never readable, which is why this was a metadata leak
  rather than a document leak — but a filename is content. "clinic
  receipt" or a lawyer's invoice names the thing a personal account exists
  to keep personal.

  These fixtures are deliberately non-empty on both sides: an empty
  private account leaks nothing however broken the guard is, and that is
  exactly the trap that produced a false pass the first time around.
*/

let h: Harness;
let alice: { userId: string; cookie: string };
let bob: { userId: string; cookie: string };

/** An account plus a transaction plus a receipt on it, as the routes would. */
function receiptOn(opts: { shared: boolean; owner: string; filename: string }): {
  attachmentId: string;
  accountId: string;
} {
  return runWithDb(h.db, () => {
    const accountId = id();
    const txId = id();
    const attachmentId = id();
    h.db
      .prepare(
        `INSERT INTO accounts (id, name, currency, kind, opening_balance, owner_id, shared,
                               color, position, created_by)
         VALUES (?, ?, 'EUR', 'card', 0, ?, ?, '#1F6E8C', 1, ?)`,
      )
      .run(
        accountId,
        opts.shared ? 'Joint' : 'Personal',
        opts.shared ? null : opts.owner,
        opts.shared ? 1 : 0,
        opts.owner,
      );
    h.db
      .prepare(
        `INSERT INTO transactions (id, kind, occurred_on, account_id, amount, created_by)
         VALUES (?, 'expense', '2026-09-01', ?, 4200, ?)`,
      )
      .run(txId, accountId, opts.owner);
    h.db
      .prepare(
        `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path,
                                  transaction_id, uploaded_by, created_at)
         VALUES (?, ?, 'application/pdf', 1234, ?, ?, ?, ?)`,
      )
      .run(attachmentId, opts.filename, `attachments/2026-09/${attachmentId}.bin`, txId, opts.owner, now());
    return { attachmentId, accountId };
  });
}

async function searchFilenames(cookie: string, q: string): Promise<string[]> {
  const res = await h.as(cookie, 'GET', `/api/search?q=${encodeURIComponent(q)}`);
  expect(res.statusCode).toBe(200);
  return res
    .json<{ results: { kind: string; title: string }[] }>()
    .results.filter((r) => r.kind === 'attachment')
    .map((r) => r.title);
}

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  bob = h.join('Bob');
});

describe('search does not leak attachments across owner_id', () => {
  it("hides a receipt on another member's personal account", async () => {
    const mine = receiptOn({ shared: false, owner: alice.userId, filename: 'PRIVATEDOC-alice.pdf' });

    // The owner finds her own receipt — otherwise this test proves nothing
    expect(await searchFilenames(alice.cookie, 'PRIVATEDOC')).toContain('PRIVATEDOC-alice.pdf');

    // The other member does not, on any surface
    expect(await searchFilenames(bob.cookie, 'PRIVATEDOC')).toEqual([]);
    const direct = await h.as(bob.cookie, 'GET', `/api/attachments/${mine.attachmentId}`);
    expect(direct.statusCode).toBe(404);
  });

  it('hides it from the administrator too — there is no admin branch', async () => {
    // Both fixtures are admins in the harness; the point is that role
    // plays no part, so Bob-as-admin is the sharpest test of it
    const listed = await h.as(bob.cookie, 'GET', '/api/accounts');
    expect(listed.json<{ name: string }[]>().map((a) => a.name)).not.toContain('Personal');
    expect(await searchFilenames(bob.cookie, 'PRIVATEDOC')).toEqual([]);
  });

  it('still shows a receipt on a shared account to everyone', async () => {
    receiptOn({ shared: true, owner: alice.userId, filename: 'SHAREDDOC-joint.pdf' });
    expect(await searchFilenames(alice.cookie, 'SHAREDDOC')).toContain('SHAREDDOC-joint.pdf');
    expect(await searchFilenames(bob.cookie, 'SHAREDDOC')).toContain('SHAREDDOC-joint.pdf');
  });

  it("still hides an attachment on another member's private note", async () => {
    const attachmentId = id();
    runWithDb(h.db, () => {
      const noteId = id();
      h.db
        .prepare(
          `INSERT INTO notes (id, title, body_md, owner_id, visibility, created_at, updated_at)
           VALUES (?, 'Alice private', '', ?, 'private', ?, ?)`,
        )
        .run(noteId, alice.userId, now(), now());
      h.db
        .prepare(
          `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path,
                                    note_id, uploaded_by, created_at)
           VALUES (?, 'NOTEDOC-secret.pdf', 'application/pdf', 10, ?, ?, ?, ?)`,
        )
        .run(attachmentId, `attachments/2026-09/${attachmentId}.bin`, noteId, alice.userId, now());
    });
    expect(await searchFilenames(alice.cookie, 'NOTEDOC')).toContain('NOTEDOC-secret.pdf');
    expect(await searchFilenames(bob.cookie, 'NOTEDOC')).toEqual([]);
  });

  it('keeps family mail attachments visible — mail has no owner', async () => {
    // The reason the fix cannot simply drop `note_id IS NULL`: a mail
    // attachment hangs on neither a note nor a transaction, and family
    // mail belongs to the household by design
    runWithDb(h.db, () => {
      const messageId = id();
      const attachmentId = id();
      h.db
        .prepare(
          `INSERT INTO mail_messages (id, kind, from_address, to_address, subject,
                                      body_text, received_at)
           VALUES (?, 'in', 'school@example.test', 'family@example.test', 'Forms', '', ?)`,
        )
        .run(messageId, now());
      h.db
        .prepare(
          `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path,
                                    mail_message_id, created_at)
           VALUES (?, 'MAILDOC-forms.pdf', 'application/pdf', 10, ?, ?, ?)`,
        )
        .run(attachmentId, `attachments/2026-09/${attachmentId}.bin`, messageId, now());
    });
    expect(await searchFilenames(alice.cookie, 'MAILDOC')).toContain('MAILDOC-forms.pdf');
    expect(await searchFilenames(bob.cookie, 'MAILDOC')).toContain('MAILDOC-forms.pdf');
  });
});

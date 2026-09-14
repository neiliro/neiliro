import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentTenant, db, openDatabase, runWithDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ingestEmail } from './mail.js';
import { deleteMessage, RETENTION_KEY, sweepMailRetention } from './mail-retention.js';
import { buildTestApp } from '../test-harness.js';

/*
  Letters leave the desk by hand or by age (#30). What the tests pin: a
  deletion takes the replies and the files with it and leaves the task;
  the sweep is off until the family chooses an age, and then removes only
  what is older than it; a kid account gets nothing from the mail routes.
*/

const PDF = Buffer.from('%PDF-1.4 fake').toString('base64');
function letter(id: string, subject: string): string {
  return [
    `Message-ID: <${id}@school.example>`,
    'From: "Riverside School" <office@school.example>',
    'To: family@neiliro.example',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please sign the attached form.',
    '--B',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="form.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    PDF,
    '--B--',
    '',
  ].join('\r\n');
}

function freshDb() {
  const database = openDatabase(':memory:');
  runWithDb(database, () => migrate());
  return database;
}

describe('deleting a letter', () => {
  it('takes the replies and the files with it and leaves the task', async () => {
    const database = freshDb();
    await runWithDb(database, async () => {
      const id = (await ingestEmail(letter('a1', 'Trip consent')))!;
      const file = (db.prepare('SELECT storage_path FROM attachments WHERE mail_message_id = ?').get(id) as { storage_path: string }).storage_path;
      const onDisk = resolve(currentTenant().attachmentsDir, file);
      expect(existsSync(onDisk)).toBe(true);
      db.prepare(
        `INSERT INTO mail_messages (id, kind, from_address, subject, body_text, received_at, in_reply_to)
         VALUES ('r1', 'out', 'family@neiliro.example', 'Re: Trip consent', 'Signed.', '2026-09-01 10:00:00', ?)`,
      ).run(id);
      db.prepare(
        `INSERT INTO tasks (id, project_id, level, title, status, priority, position)
         VALUES ('t1', '00000000-0000-4000-8000-000000000001', 0, 'Trip consent', 'todo', 'normal', 1)`,
      ).run();
      db.prepare("UPDATE mail_messages SET task_id = 't1' WHERE id = ?").run(id);

      expect(await deleteMessage(id)).toBe(true);
      expect(db.prepare('SELECT count(*) AS n FROM mail_messages').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({ n: 0 });
      expect(existsSync(onDisk)).toBe(false);
      expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE id = 't1'").get()).toEqual({ n: 1 });
      expect(await deleteMessage(id)).toBe(false);
    });
  });
});

describe('the age rule', () => {
  it('does nothing until the family chooses an age, then removes only what is older', async () => {
    const database = freshDb();
    await runWithDb(database, async () => {
      const old = (await ingestEmail(letter('b1', 'Old bill')))!;
      const fresh = (await ingestEmail(letter('b2', 'New bill')))!;
      db.prepare("UPDATE mail_messages SET received_at = '2025-01-01 10:00:00' WHERE id = ?").run(old);

      expect(await sweepMailRetention()).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM mail_messages').get()).toEqual({ n: 2 });

      db.prepare("INSERT INTO settings (key, value) VALUES (?, '180')").run(RETENTION_KEY);
      expect(await sweepMailRetention()).toBe(1);
      const left = db.prepare('SELECT id FROM mail_messages').all() as { id: string }[];
      expect(left.map((r) => r.id)).toEqual([fresh]);
      expect(db.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({ n: 1 });
    });
  });
});

describe('the mailbox and kid accounts', () => {
  it('refuses every mail route to a kid and lets an adult delete a letter', async () => {
    const h = await buildTestApp();
    const adult = h.join('Ann');
    const kid = h.join('Tim');
    h.db.prepare("UPDATE users SET role = 'kid' WHERE id = ?").run(kid.userId);
    const id = await runWithDb(h.db, () => ingestEmail(letter('c1', 'Ski trip')));

    expect((await h.as(kid.cookie, 'GET', '/api/mail')).statusCode).toBe(403);
    expect((await h.as(kid.cookie, 'GET', `/api/mail/${id}`)).statusCode).toBe(403);
    expect((await h.as(kid.cookie, 'DELETE', `/api/mail/${id}`)).statusCode).toBe(403);
    expect((await h.as(adult.cookie, 'GET', `/api/mail/${id}`)).statusCode).toBe(200);
    expect((await h.as(adult.cookie, 'DELETE', `/api/mail/${id}`)).statusCode).toBe(200);
    expect((await h.as(adult.cookie, 'GET', `/api/mail/${id}`)).statusCode).toBe(404);
  });
});

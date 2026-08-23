import { describe, expect, it } from 'vitest';
import { openDatabase, runWithDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { ingestEmail } from './mail.js';

const PDF_BASE64 = Buffer.from('%PDF-1.4 fake').toString('base64');

const RAW_WITH_ATTACHMENT = [
  'Message-ID: <trip-42@school.example>',
  'From: "Riverside School" <office@school.example>',
  'To: family@neiliro.example',
  'Subject: Trip consent form',
  'Date: Thu, 14 Aug 2026 09:00:00 +0200',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUNDARY"',
  '',
  '--BOUNDARY',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Please sign the attached form before Friday.',
  '--BOUNDARY',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="consent.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  PDF_BASE64,
  '--BOUNDARY--',
  '',
].join('\r\n');

const RAW_HTML_ONLY = [
  'Message-ID: <bill-7@power.example>',
  'From: no-reply@power.example',
  'To: family@neiliro.example',
  'Subject: Your bill',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Your bill is <b>64.20 EUR</b>.</p><p>Due by the 25th.</p></body></html>',
  '',
].join('\r\n');

function freshDb() {
  const db = openDatabase(':memory:');
  runWithDb(db, () => migrate());
  return db;
}

describe('ingestEmail', () => {
  it('stores the message with its text part and attachment', async () => {
    const db = freshDb();
    await runWithDb(db, async () => {
      const rowId = await ingestEmail(RAW_WITH_ATTACHMENT);
      expect(rowId).not.toBeNull();

      const row = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(rowId) as Record<
        string,
        unknown
      >;
      expect(row.from_address).toBe('office@school.example');
      expect(row.from_name).toBe('Riverside School');
      expect(row.subject).toBe('Trip consent form');
      expect(row.body_text).toContain('sign the attached form');
      expect(row.kind).toBe('in');
      expect(row.read_at).toBeNull();

      const attachment = db
        .prepare('SELECT filename, mime, size_bytes FROM attachments WHERE mail_message_id = ?')
        .get(rowId) as { filename: string; mime: string; size_bytes: number };
      expect(attachment.filename).toBe('consent.pdf');
      expect(attachment.mime).toBe('application/pdf');
      expect(attachment.size_bytes).toBeGreaterThan(0);
    });
  });

  it('is idempotent by Message-ID: a re-ingest returns null and adds nothing', async () => {
    const db = freshDb();
    await runWithDb(db, async () => {
      expect(await ingestEmail(RAW_WITH_ATTACHMENT)).not.toBeNull();
      expect(await ingestEmail(RAW_WITH_ATTACHMENT)).toBeNull();
      const { n } = db.prepare('SELECT count(*) AS n FROM mail_messages').get() as { n: number };
      expect(n).toBe(1);
    });
  });

  it('falls back to stripped HTML when there is no text part', async () => {
    const db = freshDb();
    await runWithDb(db, async () => {
      const rowId = await ingestEmail(RAW_HTML_ONLY);
      const row = db
        .prepare('SELECT body_text FROM mail_messages WHERE id = ?')
        .get(rowId) as { body_text: string };
      expect(row.body_text).toContain('Your bill is 64.20 EUR');
      expect(row.body_text).toContain('Due by the 25th');
      expect(row.body_text).not.toContain('<');
    });
  });
});

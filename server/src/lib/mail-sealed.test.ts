import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { currentTenant, openDatabase, runWithDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { buildTestApp, type Harness } from '../test-harness.js';
import { ingestEmail } from './mail.js';

/*
  Incoming mail sealed to the family public key (ADR 0001, #223). The
  server's part is verified from the outside: given a public key, what it
  writes opens with the matching private key and with nothing else, and
  the routes that used to read a letter's words now ask the browser for
  them.

  The opening side here mirrors web/src/lib/crypto/seal.ts step by step —
  the point of the test is that the server's sealing matches it.
*/
const RAW = [
  'Message-ID: <trip-43@school.example>',
  'From: "Riverside School" <office@school.example>',
  'To: family@neiliro.example',
  'Subject: Trip consent form',
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
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--BOUNDARY--',
  '',
].join('\r\n');

let family: webcrypto.CryptoKeyPair;
let familyPub: Buffer;

async function openKey(ephemeralPub: Buffer): Promise<webcrypto.CryptoKey> {
  const sender = await webcrypto.subtle.importKey('raw', ephemeralPub, { name: 'X25519' }, false, []);
  const shared = await webcrypto.subtle.deriveBits({ name: 'X25519', public: sender }, family.privateKey, 256);
  const hkdf = await webcrypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: Buffer.concat([ephemeralPub, familyPub]), info: Buffer.from('neiliro/seal/v1') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

async function openField(value: string, table: string, column: string, id: string): Promise<string> {
  expect(value.startsWith('s1:')).toBe(true);
  const [eph, nonce, ct] = value.slice(3).split(':');
  const key = await openKey(Buffer.from(eph!, 'base64url'));
  const pt = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Buffer.from(nonce!, 'base64url'), additionalData: Buffer.from(`${table}/${column}/${id}`) },
    key,
    Buffer.from(ct!, 'base64url'),
  );
  return Buffer.from(pt).toString('utf8');
}

async function openFile(sealed: Buffer, fileId: string): Promise<Buffer> {
  expect(sealed.subarray(0, 3).toString()).toBe('NS1');
  const key = await openKey(sealed.subarray(3, 35));
  const ne1 = sealed.subarray(35);
  expect(ne1.subarray(0, 3).toString()).toBe('NE1');
  const chunkSize = ne1.readUInt32BE(3);
  const prefix = ne1.subarray(7, 15);
  const body = ne1.subarray(15);
  const out: Buffer[] = [];
  const count = Math.max(1, Math.ceil(body.length / (chunkSize + 16)));
  for (let i = 0; i < count; i++) {
    const nonce = Buffer.alloc(12);
    prefix.copy(nonce, 0);
    nonce.writeUInt32BE(i, 8);
    const slice = body.subarray(i * (chunkSize + 16), Math.min((i + 1) * (chunkSize + 16), body.length));
    const pt = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(`file/${fileId}/${i}/${i === count - 1 ? 'last' : 'more'}`) },
      key,
      slice,
    );
    out.push(Buffer.from(pt));
  }
  return Buffer.concat(out);
}

beforeAll(async () => {
  family = (await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  familyPub = Buffer.from(await webcrypto.subtle.exportKey('raw', family.publicKey));
});

describe('ingest with a family key', () => {
  it('writes only what the family can open, and nothing the server could read back', async () => {
    const db = openDatabase(':memory:');
    runWithDb(db, () => migrate());
    await runWithDb(db, async () => {
      db.prepare("INSERT INTO family_key (id, public_key, created_at) VALUES (1, ?, datetime('now'))").run(
        familyPub.toString('base64url'),
      );
      const rowId = (await ingestEmail(RAW))!;
      const row = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(rowId) as Record<string, string>;

      // Every header a person reads is sealed; the Message-ID is not
      expect(row['message_id']).toBe('<trip-43@school.example>');
      expect(await openField(row['from_address']!, 'mail_messages', 'from_address', rowId)).toBe('office@school.example');
      expect(await openField(row['from_name']!, 'mail_messages', 'from_name', rowId)).toBe('Riverside School');
      expect(await openField(row['subject']!, 'mail_messages', 'subject', rowId)).toBe('Trip consent form');
      expect(await openField(row['body_text']!, 'mail_messages', 'body_text', rowId)).toContain('sign the attached form');
      // …and a value opens only in its own place
      await expect(openField(row['subject']!, 'mail_messages', 'body_text', rowId)).rejects.toThrow();

      const attachment = db
        .prepare('SELECT id, filename, mime, encryption, storage_path FROM attachments WHERE mail_message_id = ?')
        .get(rowId) as { id: string; filename: string; mime: string; encryption: number; storage_path: string };
      expect(attachment.encryption).toBe(2);
      expect(attachment.mime).toBe('application/pdf');
      expect(await openField(attachment.filename, 'attachments', 'filename', attachment.id)).toBe('consent.pdf');
      const bytes = readFileSync(resolve(currentTenant().attachmentsDir, attachment.storage_path));
      expect((await openFile(bytes, attachment.id)).toString()).toBe('%PDF-1.4 fake');

      // Idempotency still works on the Message-ID
      expect(await ingestEmail(RAW)).toBeNull();
    });
  });

  it('keeps writing plaintext for a family with no key yet', async () => {
    const db = openDatabase(':memory:');
    runWithDb(db, () => migrate());
    await runWithDb(db, async () => {
      const rowId = (await ingestEmail(RAW))!;
      const row = db.prepare('SELECT subject FROM mail_messages WHERE id = ?').get(rowId) as { subject: string };
      expect(row.subject).toBe('Trip consent form');
    });
  });
});

describe('routes on a sealed letter', () => {
  let h: Harness;
  let alice = { userId: '', cookie: '' };
  const messageId = '9f8e7d6c-5b4a-4392-8172-6f5e4d3c2b1a';

  beforeAll(async () => {
    h = await buildTestApp();
    alice = h.join('Alice');
    runWithDb(h.db, () => {
      h.db
        .prepare(
          `INSERT INTO mail_messages (id, message_id, kind, from_address, subject, body_text, received_at)
           VALUES (?, 'x@y', 'in', 's1:sealed:sealed:sealed', 's1:sealed:sealed:sealed', 's1:sealed:sealed:sealed', datetime('now'))`,
        )
        .run(messageId);
    });
  });

  it('asks the browser for the recipient and subject of a reply', async () => {
    const res = await h.as(alice.cookie, 'POST', `/api/mail/${messageId}/reply`, { text: 'Confirmed' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('browser');
  });

  it('links a task the browser made instead of reading the subject itself', async () => {
    const bare = await h.as(alice.cookie, 'POST', `/api/mail/${messageId}/task`, {});
    expect(bare.statusCode).toBe(400);

    const task = (await h.as(alice.cookie, 'POST', '/api/tasks', {
      project_id: '00000000-0000-4000-8000-000000000001',
      title: 'e1:AAAAAAAAAAAAAAAA:c2VhbGVk',
    })).json<{ id: string }>();
    const linked = await h.as(alice.cookie, 'POST', `/api/mail/${messageId}/task`, { task_id: task.id });
    expect(linked.statusCode).toBe(201);
    const message = (await h.as(alice.cookie, 'GET', `/api/mail/${messageId}`)).json<{ task_id: string }>();
    expect(message.task_id).toBe(task.id);
  });

  it('lets the job rewrite an old letter’s words', async () => {
    const res = await h.as(alice.cookie, 'PATCH', `/api/mail/${messageId}`, { subject: 'e1:AAAAAAAAAAAAAAAA:bmV3', body_text: 'e1:AAAAAAAAAAAAAAAA:Ym9keQ' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ subject: string }>().subject).toBe('e1:AAAAAAAAAAAAAAAA:bmV3');
  });
});

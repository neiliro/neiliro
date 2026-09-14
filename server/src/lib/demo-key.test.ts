import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase, runWithDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { seedDemo } from './demo.js';
import { DEMO_ENCRYPTED_FIELDS, encryptField, encryptSandbox, guestPublicKey } from './demo-key.js';
import { demoStrings } from './demo.strings.js';
import { FieldOpener, LOCKED_TEXT } from './envelope.js';
import { excerptOf } from './excerpt.js';
import { isCiphertext } from './ciphertext.js';

/*
  The demo's key has to produce exactly what a browser would have produced
  (#225): the same envelope, the same public half. Both are pinned with a
  fixed vector shared with web/src/lib/crypto/keys.test.ts, so a drift on
  either side fails a test rather than a guest's first screen.
*/
const RAW = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const RAW_PUBLIC = 'FYQ_1hZiYk01kDsJUM8qrRt3QbEw4Hp3cCEAvfYO8lU';

describe('the demo key mirrors the browser', () => {
  it('derives the same X25519 public half the browser does', () => {
    expect(guestPublicKey(RAW)).toBe(RAW_PUBLIC);
  });

  it('writes an e1: envelope the server-side opener reads back in its place only', async () => {
    const place = { table: 'tasks', column: 'title', id: 't1' };
    const value = encryptField(RAW, 'Repaint the hallway', place);
    expect(value.startsWith('e1:')).toBe(true);
    const opener = new FieldOpener(RAW);
    expect(await opener.open(value, place)).toBe('Repaint the hallway');
    expect(await opener.open(value, { ...place, id: 't2' })).toBe(LOCKED_TEXT);
    expect(await new FieldOpener(Buffer.alloc(32, 7)).open(value, place)).toBe(LOCKED_TEXT);
  });

  it('encrypts exactly the columns the browser encrypts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../../web/src/lib/crypto/field-map.ts'), 'utf8');
    const block = source.slice(source.indexOf('export const ENCRYPTED_FIELDS'), source.indexOf('export const CLEAR_FIELDS'));
    const parsed: Record<string, string[]> = {};
    for (const m of block.matchAll(/^\s*([a-z_]+): \[([^\]]*)\],?$/gm)) {
      parsed[m[1]!] = [...m[2]!.matchAll(/'([a-z_]+)'/g)].map((c) => c[1]!);
    }
    expect(Object.keys(parsed).length).toBeGreaterThan(15);
    expect(DEMO_ENCRYPTED_FIELDS).toEqual(parsed);
  });
});

describe('a sandbox handed out under a guest key', () => {
  it('holds only ciphertext in the encrypted columns, and the key opens it', async () => {
    const db = openDatabase(':memory:');
    await runWithDb(db, async () => {
      migrate();
      await seedDemo('en');
    });
    const admin = db.prepare(`SELECT id FROM users WHERE role = 'admin'`).get() as { id: string };
    encryptSandbox(db, RAW, admin.id, '2026-09-14T12:00:00.000Z');

    for (const [table, columns] of Object.entries(DEMO_ENCRYPTED_FIELDS)) {
      const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const column of columns) {
          const value = row[column];
          if (value === null) continue;
          expect(isCiphertext(value as string), `${table}.${column} left in the clear`).toBe(true);
        }
      }
    }
    // Wishes are the family's public face and stay readable — by decision, not by omission
    const wish = db.prepare('SELECT title FROM wishes LIMIT 1').get() as { title: string };
    expect(isCiphertext(wish.title)).toBe(false);

    const key = db.prepare('SELECT public_key, created_by FROM family_key WHERE id = 1').get() as {
      public_key: string;
      created_by: string;
    };
    expect(key).toEqual({ public_key: RAW_PUBLIC, created_by: admin.id });

    const S = demoStrings('en');
    const opener = new FieldOpener(RAW);
    const tasks = db.prepare('SELECT id, title FROM tasks').all() as { id: string; title: string }[];
    const titles = await Promise.all(tasks.map((t) => opener.open(t.title, { table: 'tasks', column: 'title', id: t.id })));
    expect(titles).toContain(S.tasks.repaint);

    // The list preview the browser writes alongside a body exists for every seeded note
    const notes = db.prepare('SELECT id, body_md, excerpt FROM notes').all() as { id: string; body_md: string; excerpt: string }[];
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      const body = await opener.open(n.body_md, { table: 'notes', column: 'body_md', id: n.id });
      expect(await opener.open(n.excerpt, { table: 'notes', column: 'excerpt', id: n.id })).toBe(excerptOf(body!));
    }
    db.close();
  });
});

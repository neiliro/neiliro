import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { runWithDb, id, now } from '../db/index.js';
import { createSession } from '../lib/auth.js';
import { demoBlocked } from '../lib/demo.js';
import { paths } from '../env.js';

/*
  The no-lock-in promise, verified end to end: an archive downloaded
  from Settings must restore into a self-hosted hub through the real
  scripts/import.mjs — not through a reimplementation of it in the test.
  If either side drifts (manifest keys, layout, integrity expectations),
  this is the test that goes red.
*/

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let h: Harness;
let admin: { userId: string; cookie: string };

beforeAll(async () => {
  h = await buildTestApp();
  admin = h.join('alex');
});

describe('family export, single-family mode', () => {
  it('round-trips through scripts/import.mjs', async () => {
    // Content worth checking on the far side: a note through the API and
    // a file in the attachments directory
    const note = await h.as(admin.cookie, 'POST', '/api/notes', {
      title: 'Packing list',
      body_md: 'passports, chargers',
    });
    expect(note.statusCode).toBe(201);
    mkdirSync(join(paths.attachments, '2026-08'), { recursive: true });
    writeFileSync(join(paths.attachments, '2026-08', 'receipt.bin'), 'receipt bytes');

    const res = await h.as(admin.cookie, 'GET', '/api/family/export');
    expect(res.statusCode).toBe(200);
    const payload = (res as unknown as { rawPayload: Buffer }).rawPayload;
    // gzip magic bytes — the response is a real archive, not JSON
    expect(payload[0]).toBe(0x1f);
    expect(payload[1]).toBe(0x8b);

    const work = mkdtempSync(join(tmpdir(), 'hub-roundtrip-'));
    const archive = join(work, 'neiliro-export.tar.gz');
    writeFileSync(archive, payload);

    // The real import script into a fresh DATA_DIR — the self-hosted
    // restore path, exactly as the docs describe it
    const restored = join(work, 'restored');
    execFileSync('node', [join(repoRoot, 'scripts', 'import.mjs'), archive], {
      env: { ...process.env, DATA_DIR: restored },
      stdio: 'pipe',
    });

    const imported = new Database(join(restored, 'hub.db'), { readonly: true });
    try {
      expect(imported.pragma('integrity_check', { simple: true })).toBe('ok');
      const users = imported.prepare('SELECT email FROM users').all() as { email: string }[];
      expect(users.map((u) => u.email)).toEqual(['alex@hub.local']);
      const notes = imported.prepare('SELECT title FROM notes').all() as { title: string }[];
      expect(notes.map((n) => n.title)).toContain('Packing list');
    } finally {
      imported.close();
    }
    expect(existsSync(join(restored, 'attachments', '2026-08', 'receipt.bin'))).toBe(true);
  });

  it('is for the administrator only', async () => {
    // The harness only mints admins; a member is two direct rows away
    const member = runWithDb(h.db, () => {
      const userId = id();
      h.db
        .prepare(
          `INSERT INTO users (id, email, name, role, password_hash, created_at)
           VALUES (?, 'kid@hub.local', 'Kim', 'member', 'x', ?)`,
        )
        .run(userId, now());
      return createSession(userId, 'kid-device');
    });

    const res = await h.as(member, 'GET', '/api/family/export');
    expect(res.statusCode).toBe(403);
  });
});

describe('family deletion, single-family mode', () => {
  it('does not exist outside the hosted service', async () => {
    // Self-hosted: one family per server, so this button would mean
    // "erase the instance" — that stays a host-level operation
    const res = await h.as(admin.cookie, 'POST', '/api/family/delete', {
      password: 'whatever',
      confirm: 'whatever',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe(
      'Family deletion is available on the hosted service only',
    );
  });

  it('is blocked in the demo alongside the other destructive routes', () => {
    expect(demoBlocked('POST', '/api/family/delete')).toBe(true);
  });
});

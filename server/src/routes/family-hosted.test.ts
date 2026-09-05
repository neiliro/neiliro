import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/*
  The GDPR pair in hosted mode: the settings export must contain exactly
  one family's data, and self-deletion must remove one family's files
  without touching its neighbours. Both promises are the whole point of
  the tenant context — so both are checked against two real families
  side by side, not against a single database where the bug could not
  show even in principle.

  Same env dance as hosted.test.ts: env.ts reads the flags at import
  time, hence the dynamic imports and the afterAll cleanup.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  tenants.shutdownHosted();
});

let app: FastifyInstance;

interface Family {
  slug: string;
  familyId: string;
  email: string;
  cookie: string;
}

/** Create a family, run first-run setup, sign the admin in. */
async function bringUpFamily(slug: string, name: string): Promise<Family> {
  const { familyId } = tenants.createFamily(slug);
  // The setup route lowercases logins; build the expectation the same way
  const email = `${name.toLowerCase()}@${slug}.test`;
  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: `${slug}.neiliro.test` },
    payload: { accept_terms: true, name, email, password: 'correct horse battery' },
  });
  expect(setup.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: `${slug}.neiliro.test` },
    payload: { email, password: 'correct horse battery' },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.find((c) => c.name === 'hub_session')!.value;
  return { slug, familyId, email, cookie };
}

function onFamily(f: Family) {
  return { host: `${f.slug}.neiliro.test`, cookie: `hub_session=${f.cookie}` };
}

/** Download the family's export and unpack it into a fresh directory. */
async function exportAndUnpack(f: Family): Promise<string> {
  const res = await app.inject({ url: '/api/family/export', headers: onFamily(f) });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/gzip');

  const dir = mkdtempSync(join(tmpdir(), 'hub-export-test-'));
  const archive = join(dir, 'export.tar.gz');
  writeFileSync(archive, res.rawPayload);
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  return dir;
}

function userEmails(dbPath: string): string[] {
  const snapshot = new Database(dbPath, { readonly: true });
  try {
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
    return (snapshot.prepare('SELECT email FROM users').all() as { email: string }[]).map(
      (r) => r.email,
    );
  } finally {
    snapshot.close();
  }
}

describe('family export in hosted mode', () => {
  let smiths: Family;
  let jones: Family;

  beforeAll(async () => {
    tenants.initHosted();
    app = await buildApp();
    smiths = await bringUpFamily('smiths-e1x1', 'Sam');
    jones = await bringUpFamily('jones-e2x2', 'Pat');
  });

  it('contains exactly the requesting family, cross-checked both ways', async () => {
    // A file in the attachments directory must ride along in the archive
    const attachmentsDir = join(env.dataDir, 'families', smiths.familyId, 'attachments');
    mkdirSync(join(attachmentsDir, '2026-08'), { recursive: true });
    writeFileSync(join(attachmentsDir, '2026-08', 'receipt.bin'), 'smiths receipt');

    const smithsDir = await exportAndUnpack(smiths);
    expect(userEmails(join(smithsDir, 'hub.db'))).toEqual([smiths.email]);
    expect(existsSync(join(smithsDir, 'attachments', '2026-08', 'receipt.bin'))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(smithsDir, 'manifest.json'), 'utf8')) as {
      counts: Record<string, number>;
      migrations: string[];
      attachments: { files: number };
    };
    expect(manifest.counts.users).toBe(1);
    expect(manifest.migrations.length).toBeGreaterThan(0);
    expect(manifest.attachments.files).toBe(1);

    const jonesDir = await exportAndUnpack(jones);
    expect(userEmails(join(jonesDir, 'hub.db'))).toEqual([jones.email]);
    expect(existsSync(join(jonesDir, 'attachments', '2026-08', 'receipt.bin'))).toBe(false);
  });
});

describe('family self-deletion', () => {
  let doomed: Family;
  let survivor: Family;

  beforeAll(async () => {
    tenants.initHosted();
    app = app ?? (await buildApp());
    doomed = await bringUpFamily('doomed-d1x1', 'Dana');
    survivor = await bringUpFamily('alive-d2x2', 'Ann');
  });

  it('refuses a wrong password and a wrong confirmation phrase', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/family/delete',
      headers: onFamily(doomed),
      payload: { password: 'not the password', confirm: doomed.slug },
    });
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json().error).toBe('The current password is incorrect');

    const wrongPhrase = await app.inject({
      method: 'POST',
      url: '/api/family/delete',
      headers: onFamily(doomed),
      payload: { password: 'correct horse battery', confirm: 'someone-else' },
    });
    expect(wrongPhrase.statusCode).toBe(400);
    expect(wrongPhrase.json().error).toBe('The confirmation phrase does not match the family address');
  });

  it('demands a TOTP code when the admin has one', async () => {
    // Straight into the family's database file: enabling TOTP through the
    // API would need a live authenticator, and the route only cares that
    // the flags are set
    const dbPath = join(env.dataDir, 'families', doomed.familyId, 'hub.db');
    const direct = new Database(dbPath);
    direct
      .prepare(`UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP', totp_confirmed_at = '2026-08-24 00:00:00'`)
      .run();
    direct.close();

    const withoutCode = await app.inject({
      method: 'POST',
      url: '/api/family/delete',
      headers: onFamily(doomed),
      payload: { password: 'correct horse battery', confirm: doomed.slug },
    });
    expect(withoutCode.statusCode).toBe(400);
    expect(withoutCode.json().error).toBe('Enter the code');

    const disarm = new Database(dbPath);
    disarm.prepare('UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL').run();
    disarm.close();
  });

  it('removes the family and leaves the neighbour untouched', async () => {
    const familyDir = join(env.dataDir, 'families', doomed.familyId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/family/delete',
      headers: onFamily(doomed),
      payload: { password: 'correct horse battery', confirm: doomed.slug },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Database files (all three WAL-mode ones) and attachments are gone;
    // backups stay — they are encrypted and expire on their own
    for (const suffix of ['', '-wal', '-shm']) {
      expect(existsSync(join(familyDir, `hub.db${suffix}`))).toBe(false);
    }
    expect(existsSync(join(familyDir, 'attachments'))).toBe(false);
    expect(existsSync(join(familyDir, 'backups'))).toBe(true);

    const registry = new Database(join(env.dataDir, 'registry.db'), { readonly: true });
    const row = registry
      .prepare('SELECT status FROM families WHERE id = ?')
      .get(doomed.familyId) as { status: string };
    registry.close();
    expect(row.status).toBe('deleted');

    // The old address now behaves like any unknown subdomain: the ghost
    // claims to be set up and rejects sign-ins — no trace, no enumeration
    const state = await app.inject({
      url: '/api/auth/state',
      headers: { host: `${doomed.slug}.neiliro.test` },
    });
    expect(state.json().initialized).toBe(true);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: `${doomed.slug}.neiliro.test` },
      payload: { email: doomed.email, password: 'correct horse battery' },
    });
    expect(login.statusCode).toBe(401);

    // The neighbour never noticed
    const alive = await app.inject({ url: '/api/auth/me', headers: onFamily(survivor) });
    expect(alive.statusCode).toBe(200);
    expect(alive.json().email).toBe(survivor.email);
  });
});

describe('family address and the one rename', () => {
  let fresh: Family;
  let neighbour: Family;

  beforeAll(async () => {
    tenants.initHosted();
    app = app ?? (await buildApp());
    fresh = await bringUpFamily('newcomers-n1x1', 'Nia');
    neighbour = await bringUpFamily('settled-s1x1', 'Sol');
  });

  it('offers a fresh family its rename for a day after setup', async () => {
    const res = await app.inject({ url: '/api/family/address', headers: onFamily(fresh) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      slug: string;
      domain: string;
      rename: { available: boolean; until: string | null; renamed: boolean };
    };
    expect(body.slug).toBe('newcomers-n1x1');
    expect(body.domain).toBe('neiliro.test');
    expect(body.rename.available).toBe(true);
    expect(body.rename.renamed).toBe(false);
    // The deadline is a day after the admin was created — setup was moments ago
    const untilMs = new Date(body.rename.until!).getTime() - Date.now();
    expect(untilMs).toBeGreaterThan(23 * 60 * 60_000);
    expect(untilMs).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('refuses malformed, occupied and unchanged addresses without spending the rename', async () => {
    const attempt = (slug: string) =>
      app.inject({ method: 'POST', url: '/api/family/rename', headers: onFamily(fresh), payload: { slug } });

    expect((await attempt('Ab')).statusCode).toBe(400);
    expect((await attempt('newcomers-n1x1')).json().error).toBe('That is already the family address');
    // A live neighbour and a reserved service name answer identically:
    // the difference is nobody's business but the operator's log
    const taken = await attempt(neighbour.slug);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('This address is not available');
    const reserved = await attempt('mail');
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json().error).toBe('This address is not available');

    const still = await app.inject({ url: '/api/family/address', headers: onFamily(fresh) });
    expect(still.json().rename.available).toBe(true);
  });

  it('moves the family once; the old host becomes the ghost', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/family/rename',
      headers: onFamily(fresh),
      payload: { slug: ' Newcomers ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, url: 'https://newcomers.neiliro.test/' });

    // Same family, same sessions, new host
    const moved = { ...fresh, slug: 'newcomers' };
    const me = await app.inject({ url: '/api/auth/me', headers: onFamily(moved) });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(fresh.email);

    // The old host answers like any unknown subdomain: set up, nobody home
    const old = await app.inject({ url: '/api/auth/me', headers: onFamily(fresh) });
    expect(old.statusCode).toBe(401);

    const after = await app.inject({ url: '/api/family/address', headers: onFamily(moved) });
    expect(after.json()).toMatchObject({
      slug: 'newcomers',
      rename: { available: false, until: null, renamed: true },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/family/rename',
      headers: onFamily(moved),
      payload: { slug: 'newcomers-two' },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe('The family address can no longer be changed');

    // The neighbour never noticed
    const neighbourAddress = await app.inject({ url: '/api/family/address', headers: onFamily(neighbour) });
    expect(neighbourAddress.json().slug).toBe(neighbour.slug);
  });

  it('closes the window a day after setup', async () => {
    const late = await bringUpFamily('latecomers-l1x1', 'Lee');
    // Age the admin account past the window, straight in the family's file
    const direct = new Database(join(env.dataDir, 'families', late.familyId, 'hub.db'));
    direct.prepare(`UPDATE users SET created_at = datetime('now', '-25 hours')`).run();
    direct.close();

    const state = await app.inject({ url: '/api/family/address', headers: onFamily(late) });
    expect(state.json().rename).toEqual({ available: false, until: null, renamed: false });

    const res = await app.inject({
      method: 'POST',
      url: '/api/family/rename',
      headers: onFamily(late),
      payload: { slug: 'latecomers' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('The family address can no longer be changed');
    expect(tenants.familySlug(late.familyId)).toBe('latecomers-l1x1');
  });
});

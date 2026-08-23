import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/*
  Hosted mode: family = subdomain = one database file (lib/tenants.ts).

  env.ts reads the environment at import time, so the hosted flags are
  set before any app module is pulled in — hence the dynamic imports.
  The flags are removed in afterAll: vitest can reuse a fork for the
  next test file, and process.env survives module isolation.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  tenants.shutdownHosted();
});

function onHost(host: string) {
  return { host };
}

describe('slugFromHost', () => {
  beforeAll(() => tenants.initHosted());

  it('takes the first label under the apex, case- and port-insensitive', () => {
    expect(tenants.slugFromHost('smiths-x7k2.neiliro.test')).toBe('smiths-x7k2');
    expect(tenants.slugFromHost('SMITHS-X7K2.NEILIRO.TEST:443')).toBe('smiths-x7k2');
  });

  it('resolves nothing for the apex, nested labels and foreign hosts', () => {
    expect(tenants.slugFromHost('neiliro.test')).toBeNull();
    expect(tenants.slugFromHost('a.b.neiliro.test')).toBeNull();
    expect(tenants.slugFromHost('evil.example.com')).toBeNull();
    expect(tenants.slugFromHost('xneiliro.test')).toBeNull();
    expect(tenants.slugFromHost(undefined)).toBeNull();
  });
});

describe('createFamily', () => {
  beforeAll(() => tenants.initHosted());

  it('rejects malformed, reserved and taken slugs', () => {
    expect(() => tenants.createFamily('ab')).toThrow(/Bad slug/);
    expect(() => tenants.createFamily('-petrovs')).toThrow(/Bad slug/);
    expect(() => tenants.createFamily('petrovs!')).toThrow(/Bad slug/);
    expect(() => tenants.createFamily('mail')).toThrow(/reserved/);

    tenants.createFamily('taken-q1w2');
    expect(() => tenants.createFamily('taken-q1w2')).toThrow(/already taken/);
  });
});

describe('host routing', () => {
  let app: FastifyInstance;
  let smithsId: string;

  beforeAll(async () => {
    tenants.initHosted();
    smithsId = tenants.createFamily('smiths-a1b2').familyId;
    tenants.createFamily('jones-c3d4');
    app = await buildApp();
  });

  it('keeps families in separate databases: setup on one leaves the other pristine', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('smiths-a1b2.neiliro.test'),
      payload: { name: 'Sam', email: 'sam@smiths.test', password: 'correct horse battery' },
    });
    expect(created.statusCode).toBe(201);

    const smiths = await app.inject({
      url: '/api/auth/state',
      headers: onHost('smiths-a1b2.neiliro.test'),
    });
    expect(smiths.json().initialized).toBe(true);

    // The other family still waits for its own first run — nothing leaked
    const jones = await app.inject({
      url: '/api/auth/state',
      headers: onHost('jones-c3d4.neiliro.test'),
    });
    expect(jones.json().initialized).toBe(false);
  });

  it('lets a family sign in on its own subdomain only', async () => {
    const login = (host: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: onHost(host),
        payload: { email: 'sam@smiths.test', password: 'correct horse battery' },
      });

    expect((await login('smiths-a1b2.neiliro.test')).statusCode).toBe(200);
    expect((await login('jones-c3d4.neiliro.test')).statusCode).toBe(401);
  });

  it('shows an unknown subdomain as an already-set-up hub (anti-enumeration)', async () => {
    const state = await app.inject({
      url: '/api/auth/state',
      headers: onHost('nosuch-x9y8.neiliro.test'),
    });
    expect(state.json()).toEqual({ initialized: true, google: false, demo: false });

    // ...that rejects a sign-in exactly like a real family would
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: onHost('nosuch-x9y8.neiliro.test'),
      payload: { email: 'admin@example.com', password: 'whatever else' },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().error).toBe('Wrong login or password');

    // ...and can never be claimed through the first-run endpoint
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('nosuch-x9y8.neiliro.test'),
      payload: { name: 'Eve', email: 'eve@evil.test', password: 'longenoughpass' },
    });
    expect(setup.statusCode).toBe(403);
  });

  it('counts module requests into per-family day stats, never the ghost', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: onHost('smiths-a1b2.neiliro.test'),
      payload: { email: 'sam@smiths.test', password: 'correct horse battery' },
    });
    const session = login.cookies.find((c) => c.name === 'hub_session')!;

    const tasks = await app.inject({
      url: '/api/tasks',
      headers: { ...onHost('smiths-a1b2.neiliro.test'), cookie: `hub_session=${session.value}` },
    });
    expect(tasks.statusCode).toBe(200);

    const stats = await import('../lib/hosted-stats.js');
    stats.flushHostedStats();
    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const { env } = await import('../env.js');
    const db = new Database(join(env.dataDir, 'hosted-stats.db'), { readonly: true });
    const rows = db.prepare('SELECT family_id, requests, active_users FROM family_days').all() as {
      family_id: string;
      requests: number;
      active_users: number;
    }[];
    db.close();

    // Exactly one family has activity — and it is a real one, not the
    // ghost: probes at unknown subdomains must leave no trace here
    expect(rows).toHaveLength(1);
    expect(rows[0]!.family_id).toBe(smithsId);
    expect(rows[0]!.requests).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.active_users).toBe(1);
  });

  it('runs background jobs once per family, each inside its own database', async () => {
    const seen: number[] = [];
    const { db } = await import('../db/index.js');
    await tenants.forEachFamily(() => {
      seen.push((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n);
    });
    // Three families exist by now (taken-q1w2, smiths, jones); exactly one has a user
    expect(seen).toHaveLength(3);
    expect(seen.filter((n) => n === 1)).toHaveLength(1);
  });
});

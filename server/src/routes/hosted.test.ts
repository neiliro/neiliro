import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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
const { env } = await import('../env.js');

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

    /*
      The service's own entrances must stay unclaimable — a family holding
      one would take over a door, not merely confuse a URL. `auth` is the
      single Google callback host (routes/google.ts); `in` is the inbound
      mail webhook (routes/mail-inbound.ts).

      Note which rule actually stops each one. `auth` is refused by
      RESERVED_SLUGS; `in` and `mx` never reach that list, because the slug
      pattern demands three characters. So they are guarded twice, and the
      assertion is "refused", not "refused for this reason" — a refactor
      that relaxed the length rule would still have the reserved list, and
      this test would still hold.
    */
    expect(() => tenants.createFamily('auth')).toThrow(/reserved/);
    expect(() => tenants.createFamily('in')).toThrow();
    expect(() => tenants.createFamily('mx')).toThrow();

    tenants.createFamily('taken-q1w2');
    expect(() => tenants.createFamily('taken-q1w2')).toThrow(/already taken/);
  });
});

describe('renameFamily', () => {
  beforeAll(() => tenants.initHosted());

  it('moves the family once, routes the new slug at once and retires the old one', () => {
    const family = tenants.createFamily('smiths-r1n1');
    expect(tenants.familyAddress(family.familyId)).toEqual({ slug: 'smiths-r1n1', renamedAt: null });

    // Warm the cache both ways: the old slug as a hit, the new one as a
    // miss. A rename that left either entry behind would keep routing
    // the old name (or refusing the new one) for the cache's 30 s.
    expect(tenants.tenantForSlug('smiths-r1n1')?.familyId).toBe(family.familyId);
    expect(tenants.tenantForSlug('smiths')).toBeNull();

    const { url } = tenants.renameFamily(family.familyId, 'smiths');
    expect(url).toBe('https://smiths.neiliro.test/');
    expect(tenants.familySlug(family.familyId)).toBe('smiths');
    expect(tenants.familyAddress(family.familyId)?.renamedAt).not.toBeNull();
    expect(tenants.tenantForSlug('smiths')?.familyId).toBe(family.familyId);
    expect(tenants.tenantForSlug('smiths-r1n1')).toBeNull();

    // Once: the ticket is spent
    expect(() => tenants.renameFamily(family.familyId, 'smiths-again')).toThrow(/already been renamed/);

    // The old name is retired for good — like a deleted family's slug, a
    // stranger inheriting it would inherit bookmarks and mail
    expect(() => tenants.createFamily('smiths-r1n1')).toThrow(/already taken/);
    const other = tenants.createFamily('other-o1o1');
    expect(() => tenants.renameFamily(other.familyId, 'smiths-r1n1')).toThrow(/already taken/);
  });

  it('passes the same gate as creation', () => {
    const family = tenants.createFamily('gated-g1t1');
    tenants.createFamily('occupied-c1c1');
    expect(() => tenants.renameFamily(family.familyId, 'ab')).toThrow(/Bad slug/);
    expect(() => tenants.renameFamily(family.familyId, 'mail')).toThrow(/reserved/);
    expect(() => tenants.renameFamily(family.familyId, 'occupied-c1c1')).toThrow(/already taken/);
    expect(() => tenants.renameFamily(family.familyId, 'gated-g1t1')).toThrow(/already the family address/);
    // A refused rename spends nothing
    expect(tenants.familyAddress(family.familyId)).toEqual({ slug: 'gated-g1t1', renamedAt: null });
  });
});

describe('suspension and deletion', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tenants.initHosted();
    app = await buildApp();
  });

  /*
    Suspension is an operator action taken straight in the registry (the
    control plane's set-status script), so the test writes the status the
    same way the operator does.

    Both cases below use a family the app has never served: familyIdBySlug
    caches a slug for 30 s, so a status flipped under a warm slug keeps
    answering in the old state until the TTL passes. That is accepted
    behaviour — suspension is an operator action, not a security boundary —
    and it is why these tests start cold rather than sleeping.
  */
  function setStatus(slug: string, status: string): void {
    const registry = new Database(join(env.dataDir, 'registry.db'));
    registry.prepare('UPDATE families SET status = ? WHERE slug = ?').run(status, slug);
    registry.close();
  }

  it('hides a suspended family behind the ghost, and keeps its data', () => {
    const family = tenants.createFamily('paused-p1q2');
    setStatus('paused-p1q2', 'suspended');

    const dbFile = join(env.dataDir, 'families', family.familyId, 'hub.db');
    expect(existsSync(dbFile)).toBe(true); // suspended is not deleted

    return app
      .inject({ url: '/api/auth/state', headers: onHost('paused-p1q2.neiliro.test') })
      .then(async (state) => {
        // Indistinguishable from an unknown subdomain: a suspended family
        // must not be enumerable either
        expect(state.statusCode).toBe(200);

        const setup = await app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          headers: onHost('paused-p1q2.neiliro.test'),
          payload: { accept_terms: true, name: 'Squatter', email: 'squatter@example.test', password: 'correct horse battery' },
        });
        // The ghost's decoy database may never grow an admin — whoever
        // "set it up" would own every unknown subdomain at once
        expect(setup.statusCode).toBe(403);

        // And the family's own file is still untouched by that attempt
        expect(existsSync(dbFile)).toBe(true);
      });
  });

  it('never re-issues the slug of a deleted family', () => {
    const family = tenants.createFamily('gone-g1h2');
    tenants.deleteFamilyData(family.familyId);

    expect(existsSync(join(env.dataDir, 'families', family.familyId, 'hub.db'))).toBe(false);
    // A stranger inheriting the slug would inherit bookmarks and mail
    // addressed to the family that left
    expect(() => tenants.createFamily('gone-g1h2')).toThrow(/already taken/);
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
      payload: { accept_terms: true, name: 'Sam', email: 'sam@smiths.test', password: 'correct horse battery' },
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
    const ghost = await app.inject({
      url: '/api/auth/state',
      headers: onHost('nosuch-x9y8.neiliro.test'),
    });
    /*
      Compared against a real family rather than against a literal, so the
      property under test is "indistinguishable" rather than "these four
      fields". Every flag added to this response — the Google button, the
      password-reset link — has to read the same on both, or the sign-in
      screen starts telling strangers which subdomains are real. A literal
      would have let such a flag through as long as someone updated it.
    */
    const real = await app.inject({
      url: '/api/auth/state',
      headers: onHost('smiths-a1b2.neiliro.test'),
    });
    expect(ghost.json()).toEqual(real.json());
    expect(ghost.json()).toMatchObject({ initialized: true, hosted: true });

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
      payload: { accept_terms: true, name: 'Eve', email: 'eve@evil.test', password: 'longenoughpass' },
    });
    expect(setup.statusCode).toBe(403);
  });

  it('keeps a renamed family behind the session: the public name is the brand', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: onHost('smiths-a1b2.neiliro.test'),
      payload: { email: 'sam@smiths.test', password: 'correct horse battery' },
    });
    const session = login.cookies.find((c) => c.name === 'hub_session')!;
    const asSam = { ...onHost('smiths-a1b2.neiliro.test'), cookie: `hub_session=${session.value}` };

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: asSam,
      payload: { 'home.name': 'The Smiths' },
    });
    expect(renamed.statusCode).toBe(200);

    // The name is theirs and it works — behind the session
    const settings = await app.inject({ url: '/api/settings', headers: asSam });
    expect(settings.json()['home.name']).toBe('The Smiths');

    // ...but /api/home-name is public, and the sign-in screen of a hosted
    // family must stay indistinguishable from a subdomain that does not
    // exist. A chosen name handed to the internet would enumerate families
    // by itself.
    const named = await app.inject({ url: '/api/home-name', headers: onHost('smiths-a1b2.neiliro.test') });
    expect(named.json()).toEqual({ name: 'Neiliro' });

    const ghost = await app.inject({ url: '/api/home-name', headers: onHost('nosuch-x9y8.neiliro.test') });
    expect(ghost.json()).toEqual({ name: 'Neiliro' });
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
    // One visit per active family — the count comes from the registry
    // rather than a tally of what earlier tests created, so a new test
    // above does not have to know about this one. Exactly one family
    // (smiths) has a user.
    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const registry = new Database(join(env.dataDir, 'registry.db'), { readonly: true });
    const { n: active } = registry
      .prepare("SELECT count(*) AS n FROM families WHERE status = 'active'")
      .get() as { n: number };
    registry.close();
    expect(active).toBeGreaterThanOrEqual(3);
    expect(seen).toHaveLength(active);
    expect(seen.filter((n) => n === 1)).toHaveLength(1);
  });
});

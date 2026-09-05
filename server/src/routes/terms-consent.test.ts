import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

/*
  Consent to the terms and the privacy policy (migration 031). On the hosted
  service both account-creating routes refuse without it and record when it
  was given; the login screen learns where the documents live from the apex
  in /api/auth/state.

  Same env dance as hosted.test.ts: env.ts reads the flags at import time.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');

const PASSWORD = 'correct horse battery';
const onHost = (slug: string) => ({ host: `${slug}.neiliro.test` });
const familyDb = (familyId: string) =>
  new Database(join(env.dataDir, 'families', familyId, 'hub.db'), { readonly: true });

let app: FastifyInstance;
beforeAll(async () => {
  tenants.initHosted();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  tenants.shutdownHosted();
});

describe('terms consent on the hosted service', () => {
  it('tells the login screen where the documents live, on real families and ghosts alike', async () => {
    tenants.createFamily('consent-apex');
    const real = await app.inject({ url: '/api/auth/state', headers: onHost('consent-apex') });
    expect(real.json()).toMatchObject({ hosted: true, apex: 'neiliro.test' });
    const ghost = await app.inject({ url: '/api/auth/state', headers: onHost('nobody-here') });
    expect(ghost.json()).toMatchObject({ hosted: true, apex: 'neiliro.test' });
  });

  it('refuses the open first run without consent and creates nobody', async () => {
    const { familyId } = tenants.createFamily('consent-setup');
    const refused = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('consent-setup'),
      payload: { name: 'Sam', email: 'sam@example.test', password: PASSWORD },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Terms of Service and Privacy Policy/);
    // `false` is not consent either
    const unticked = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('consent-setup'),
      payload: { name: 'Sam', email: 'sam@example.test', password: PASSWORD, accept_terms: false },
    });
    expect(unticked.statusCode).toBe(400);
    const db = familyDb(familyId);
    expect(db.prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('consent-setup'),
      payload: { name: 'Sam', email: 'sam@example.test', password: PASSWORD, accept_terms: true },
    });
    expect(ok.statusCode).toBe(201);
    const row = db.prepare('SELECT terms_accepted_at FROM users').get() as { terms_accepted_at: string | null };
    expect(row.terms_accepted_at).not.toBeNull();
    db.close();
  });

  it('refuses an invitation without consent and leaves the link alive', async () => {
    const { familyId } = tenants.createFamily('consent-join');
    const admin = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('consent-join'),
      payload: { name: 'Sam', email: 'sam@example.test', password: PASSWORD, accept_terms: true },
    });
    const cookie = admin.cookies.find((c) => c.name === 'hub_session')!;
    const invite = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { ...onHost('consent-join'), cookie: `${cookie.name}=${cookie.value}` },
      payload: { role: 'member' },
    });
    expect(invite.statusCode).toBe(201);
    const token = (invite.json() as { path: string }).path.split('token=')[1]!;

    const refused = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('consent-join'),
      payload: { token, name: 'Dana', email: 'dana@example.test', password: PASSWORD },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Terms of Service and Privacy Policy/);

    // The refusal did not burn the single-use link
    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('consent-join'),
      payload: { token, name: 'Dana', email: 'dana@example.test', password: PASSWORD, accept_terms: true },
    });
    expect(joined.statusCode).toBe(201);
    const db = familyDb(familyId);
    const dana = db
      .prepare("SELECT terms_accepted_at FROM users WHERE email = 'dana@example.test'")
      .get() as { terms_accepted_at: string | null };
    expect(dana.terms_accepted_at).not.toBeNull();
    db.close();
  });
});

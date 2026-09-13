import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
// Not test-harness: that would import app.js before the hosted flags below are set
import { deriveAuthKey } from '../lib/kdf.js';
const SALT = '00112233445566778899aabbccddeeff';
const authKey = (password: string) => deriveAuthKey(password, SALT);

/*
  Billing (#265): Paddle's signed events move a family between writable
  and read-only; the wall in app.ts enforces it; letters go out once.
  Same env dance and mail stub as founder-invite.test.ts.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';
process.env.MAILGUN_API_KEY = 'test-api-key';
process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test_secret';

const sent: { to: string; subject: string }[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: FormData }) => {
    const f = (k: string) => String(init.body.get(k) ?? '');
    sent.push({ to: f('to'), subject: f('subject') });
    return { ok: true, status: 200, json: async () => ({ id: '<sent@mail.neiliro.test>' }) };
  }),
);

const tenants = await import('../lib/tenants.js');
const { sweepPlans } = await import('../lib/plan-letters.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');

afterAll(() => {
  for (const k of ['HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY', 'MAILGUN_API_KEY', 'PADDLE_WEBHOOK_SECRET'])
    delete process.env[k];
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

let app: FastifyInstance;
const DAY = 24 * 60 * 60_000;
const PASSWORD = 'correct horse battery';
const registry = () => new Database(join(env.dataDir, 'registry.db'));
const onHost = (slug: string) => ({ host: `${slug}.neiliro.test` });

function signed(body: object, secret = 'pdl_ntfset_test_secret', ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const h1 = createHmac('sha256', secret).update(`${ts}:${raw}`).digest('hex');
  return { raw, header: `ts=${ts};h1=${h1}` };
}
const post = (raw: string, header: string, host = 'billing.neiliro.test') =>
  app.inject({
    method: 'POST',
    url: '/api/billing/paddle',
    headers: { host, 'content-type': 'application/json', 'paddle-signature': header },
    payload: raw,
  });
const event = (type: string, familyId: string, over: Record<string, unknown> = {}, id = `evt_${Math.random().toString(36).slice(2)}`) => ({
  event_id: id,
  event_type: type,
  occurred_at: new Date().toISOString(),
  data: {
    id: 'sub_01test',
    status: 'active',
    customer_id: 'ctm_01test',
    custom_data: { family_id: familyId },
    current_billing_period: { starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 30 * DAY).toISOString() },
    ...over,
  },
});

async function familyWithAdmin(slug: string, email: string) {
  const { familyId } = tenants.createFamily(slug);
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: onHost(slug),
    payload: { accept_terms: true, kdf_salt: SALT, name: 'Admin', email, auth_key: await authKey(PASSWORD), timezone: 'UTC' },
  });
  expect(res.statusCode).toBe(201);
  const cookie = res.headers['set-cookie'] as string;
  return { familyId, cookie: cookie.split(';')[0]! };
}
const ageFamily = (familyId: string, days: number) =>
  registry()
    .prepare('UPDATE families SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - days * DAY).toISOString().replace('T', ' ').slice(0, 19), familyId);

describe('the Paddle webhook', () => {
  let familyId: string;
  beforeAll(async () => {
    tenants.initHosted();
    app = await buildApp();
    ({ familyId } = await familyWithAdmin('payers-p1a1', 'pat@payers.test'));
    // Created after the columns existed: on trial, not grandfathered
    registry().prepare("UPDATE families SET plan = NULL WHERE id = ?").run(familyId);
  });

  it('exists only on billing.<apex> and refuses a bad or stale signature', async () => {
    const { raw, header } = signed(event('subscription.activated', familyId));
    expect((await post(raw, header, 'payers-p1a1.neiliro.test')).statusCode).toBe(404);
    expect((await post(raw, 'ts=1;h1=deadbeef')).statusCode).toBe(401);
    const forged = signed(event('subscription.activated', familyId), 'wrong-secret');
    expect((await post(forged.raw, forged.header)).statusCode).toBe(401);
    const stale = signed(event('subscription.activated', familyId), undefined, Math.floor(Date.now() / 1000) - 3600);
    expect((await post(stale.raw, stale.header)).statusCode).toBe(401);
    expect(tenants.planRow(familyId)!.plan).toBeNull();
  });

  it('records an activated subscription and a replay of the same event changes nothing', async () => {
    const ev = event('subscription.activated', familyId, {}, 'evt_once');
    const { raw, header } = signed(ev);
    expect((await post(raw, header)).statusCode).toBe(200);
    const row = tenants.planRow(familyId)!;
    expect(row.plan).toBe('paid');
    expect(row.subscription_status).toBe('active');
    expect(row.paddle_customer_id).toBe('ctm_01test');

    const later = signed({ ...ev, data: { ...ev.data, status: 'canceled' } });
    const replay = await post(later.raw, later.header);
    expect(replay.json()).toEqual({ ok: true, replay: true });
    expect(tenants.planRow(familyId)!.subscription_status).toBe('active');
  });

  it('an event naming no live family is acknowledged, not retried', async () => {
    const { raw, header } = signed(event('subscription.updated', 'no-such-family'));
    expect((await post(raw, header)).statusCode).toBe(200);
  });

  it('a cancellation runs to the end of the paid period, then the hub is read-only', async () => {
    const ends = new Date(Date.now() + 5 * DAY).toISOString();
    const { raw, header } = signed(event('subscription.canceled', familyId, { status: 'canceled', current_billing_period: { starts_at: new Date().toISOString(), ends_at: ends } }));
    expect((await post(raw, header)).statusCode).toBe(200);
    const row = tenants.planRow(familyId)!;
    expect(row.subscription_status).toBe('canceled');
    expect(row.plan_until).toBe(ends.replace('T', ' ').slice(0, 19));
  });
});

describe('the read-only wall', () => {
  let familyId: string;
  let cookie: string;
  beforeAll(async () => {
    ({ familyId, cookie } = await familyWithAdmin('lapsed-l1a1', 'lee@lapsed.test'));
    registry().prepare("UPDATE families SET plan = NULL WHERE id = ?").run(familyId);
  });
  const H = () => ({ ...onHost('lapsed-l1a1'), cookie });

  it('lets a family on trial write', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/notes', headers: H(), payload: { title: 'on trial' } });
    expect(res.statusCode).toBe(201);
    const plan = await app.inject({ method: 'GET', url: '/api/family/plan', headers: H() });
    expect(plan.json().state).toBe('trial');
    expect(plan.json().checkout_url).toContain(`family=${familyId}`);
  });

  it('after the trial: reads, export and sign-out still work, writes answer 402', async () => {
    ageFamily(familyId, 31);
    const write = await app.inject({ method: 'POST', url: '/api/notes', headers: H(), payload: { title: 'too late' } });
    expect(write.statusCode).toBe(402);
    expect(write.json()).toEqual({ error: 'The hub is read-only until the family subscribes', code: 'read_only' });

    expect((await app.inject({ method: 'GET', url: '/api/notes', headers: H() })).statusCode).toBe(200);
    const plan = await app.inject({ method: 'GET', url: '/api/family/plan', headers: H() });
    expect(plan.json().read_only).toBe(true);
    expect(plan.json().state).toBe('read_only');
    expect((await app.inject({ method: 'GET', url: '/api/family/export', headers: H() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: H() })).statusCode).toBeLessThan(400);
  });

  it('a subscription arriving through the webhook reopens the hub on the next request', async () => {
    const { raw, header } = signed(event('subscription.activated', familyId, { id: 'sub_02lapsed' }));
    expect((await post(raw, header)).statusCode).toBe(200);
    const { cookie: fresh } = { cookie: (await login('lapsed-l1a1', 'lee@lapsed.test')) };
    const write = await app.inject({ method: 'POST', url: '/api/notes', headers: { ...onHost('lapsed-l1a1'), cookie: fresh }, payload: { title: 'back' } });
    expect(write.statusCode).toBe(201);
  });

  it('the portal link needs a subscription and an API key', async () => {
    const fresh = await login('lapsed-l1a1', 'lee@lapsed.test');
    const res = await app.inject({ method: 'POST', url: '/api/family/plan/portal', headers: { ...onHost('lapsed-l1a1'), cookie: fresh } });
    expect(res.statusCode).toBe(503); // subscribed, but PADDLE_API_KEY is unset here
  });
});

async function login(slug: string, email: string): Promise<string> {
  const pre = await app.inject({ method: 'POST', url: '/api/auth/prelogin', headers: onHost(slug), payload: { email } });
  const salt = pre.json().salt as string;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: onHost(slug),
    payload: { email, auth_key: await deriveAuthKey(PASSWORD, salt) },
  });
  expect(res.statusCode).toBe(200);
  return (res.headers['set-cookie'] as string).split(';')[0]!;
}

describe('the plan letters and the last consequence', () => {
  it('writes to the administrators a week before the free period ends, once; removes the family sixty days after read-only', async () => {
    const { familyId } = await familyWithAdmin('ending-e1a1', 'eve@ending.test');
    registry().prepare("UPDATE families SET plan = NULL WHERE id = ?").run(familyId);
    ageFamily(familyId, 25); // trial ends in 5 days
    sent.length = 0;
    const first = await sweepPlans();
    expect(first.letters).toBe(1);
    expect(sent[0]).toMatchObject({ to: 'eve@ending.test', subject: 'Your free period ends in a week' });
    const again = await sweepPlans();
    expect(again.letters).toBe(0);

    ageFamily(familyId, 31 + 60 + 1); // read-only for 61 days
    const last = await sweepPlans();
    expect(last.removed).toBe(1);
    expect((registry().prepare('SELECT status FROM families WHERE id = ?').get(familyId) as { status: string }).status).toBe('deleted');
  });

  it('never writes to a grandfathered family without an end date', async () => {
    const { familyId } = await familyWithAdmin('legacy-l1a1', 'lou@legacy.test');
    tenants.setPlan(familyId, 'legacy_free', null);
    ageFamily(familyId, 400);
    sent.length = 0;
    const r = await sweepPlans();
    expect(r).toEqual({ letters: 0, removed: 0 });
    expect(sent).toHaveLength(0);
  });
});

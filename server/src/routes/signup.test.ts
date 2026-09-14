import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
// Not test-harness: that would import app.js before the hosted flags below are set
import { deriveAuthKey } from '../lib/kdf.js';
const SALT = '00112233445566778899aabbccddeeff';
const authKey = (password: string) => deriveAuthKey(password, SALT);

/*
  Self-serve sign-up (#262): the landing page creates the family through
  signup.<apex>, and the letter is the only place the family's address
  appears. Same env dance and mail stub as founder-invite.test.ts.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';
process.env.MAILGUN_API_KEY = 'test-api-key';
process.env.SIGNUP_TOKEN = 'test-signup-token';
process.env.SIGNUP_HOURLY_CAP = '6';

interface Sent {
  to: string;
  text: string;
}
const sent: Sent[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: FormData }) => {
    const f = (k: string) => String(init.body.get(k) ?? '');
    sent.push({ to: f('to'), text: f('text') });
    return { ok: true, status: 200, json: async () => ({ id: '<sent@mail.neiliro.test>' }) };
  }),
);

const tenants = await import('../lib/tenants.js');
const { reapUnclaimedFamilies } = await import('../lib/reaper.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');

afterAll(() => {
  for (const k of ['HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY', 'MAILGUN_API_KEY', 'SIGNUP_TOKEN', 'SIGNUP_HOURLY_CAP'])
    delete process.env[k];
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

let app: FastifyInstance;
const SIGNUP = { host: 'signup.neiliro.test', authorization: 'Bearer test-signup-token' };
const registry = () => new Database(join(env.dataDir, 'registry.db'), { readonly: true });
const familyDb = (id: string) => new Database(join(env.dataDir, 'families', id, 'hub.db'));
const rowByEmail = (email: string) =>
  registry().prepare("SELECT id, slug, status FROM families WHERE founder_email = ? AND status = 'active'").all(email) as {
    id: string; slug: string; status: string;
  }[];
const slugOf = (mail: Sent) => new URL(mail.text.match(/https:\/\/\S+\/join\?\S+/)![0]).host.split('.')[0]!;
const tokenOf = (mail: Sent) => new URL(mail.text.match(/https:\/\/\S+\/join\?\S+/)![0]).searchParams.get('token')!;

// Each call from its own address: the per-IP limit (10/min) is not what
// these tests are about, the process-wide fuse is
let ip = 0;
const signup = (body: unknown, headers: Record<string, string> = SIGNUP) =>
  app.inject({ method: 'POST', url: '/api/signup', headers, payload: body as object, remoteAddress: `10.0.${Math.floor(++ip / 250)}.${ip % 250}` });

describe('self-serve sign-up', () => {
  beforeAll(async () => {
    // The fuse counts within a fixed clock hour (routes/signup.ts). A run
    // that starts at xx:59:45 crosses into the next hour mid-file and the
    // count restarts — CI hit exactly that on 2026-09-14. Pin the clock
    // to the middle of an hour for the whole file; Date only, so Fastify's
    // own timers keep running.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-14T10:30:00.000Z') });
    tenants.initHosted();
    app = await buildApp();
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('exists only on signup.<apex> and only with the bearer', async () => {
    const onFamilyHost = await signup({ family_name: 'X', email: 'a@example.test' }, { host: 'petrovy-ab12.neiliro.test', authorization: SIGNUP.authorization });
    expect(onFamilyHost.statusCode).toBe(404);
    const noToken = await signup({ family_name: 'X', email: 'a@example.test' }, { host: SIGNUP.host });
    expect(noToken.statusCode).toBe(401);
    const wrongToken = await signup({ family_name: 'X', email: 'a@example.test' }, { host: SIGNUP.host, authorization: 'Bearer nope' });
    expect(wrongToken.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('refuses a body without a name or with a non-address, in a sentence', async () => {
    expect((await signup({ family_name: '', email: 'a@example.test' })).statusCode).toBe(400);
    const bad = await signup({ family_name: 'Петровы', email: 'not-an-address' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('That is not an email address');
    expect(sent).toHaveLength(0);
  });

  it('creates the family from the name, mails the founder, and tells the caller nothing else', async () => {
    const res = await signup({ family_name: 'Петровы', email: 'Sam@Example.test' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const rows = rowByEmail('sam@example.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toMatch(/^petrovy-[a-z0-9]{4}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('sam@example.test');
    expect(slugOf(sent[0]!)).toBe(rows[0]!.slug);
  });

  it('re-issues the invitation for the same address while the family is unclaimed', async () => {
    const before = rowByEmail('sam@example.test')[0]!;
    const first = tokenOf(sent[0]!);
    const res = await signup({ family_name: 'Petrov family', email: 'sam@example.test' });
    expect(res.statusCode).toBe(202);
    expect(rowByEmail('sam@example.test')).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(slugOf(sent[1]!)).toBe(before.slug);
    expect(tokenOf(sent[1]!)).not.toBe(first);
    const db = familyDb(before.id);
    expect((db.prepare("SELECT count(*) AS n FROM invites WHERE role = 'admin' AND used_at IS NULL").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('the letter opens the first run on that family, and the address is then free for another family', async () => {
    const mail = sent[1]!;
    const join = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: { host: `${slugOf(mail)}.neiliro.test` },
      payload: { accept_terms: true, kdf_salt: SALT, token: tokenOf(mail), name: 'Sam', email: 'sam@example.test', auth_key: await authKey('correct horse battery') },
    });
    expect(join.statusCode).toBe(201);

    const res = await signup({ family_name: 'Petrovs abroad', email: 'sam@example.test' });
    expect(res.statusCode).toBe(202);
    const rows = rowByEmail('sam@example.test');
    expect(rows).toHaveLength(2);
    expect(sent).toHaveLength(3);
    expect(slugOf(sent[2]!)).toMatch(/^petrovs-abroad-[a-z0-9]{4}$/);
  });

  it('spells a name with no slug material as "family"', async () => {
    await signup({ family_name: '🏠', email: 'home@example.test' });
    expect(rowByEmail('home@example.test')[0]!.slug).toMatch(/^family-[a-z0-9]{4}$/);
  });

  it('trips the hourly fuse with a 503 instead of more letters', async () => {
    // Four requests reached the fuse so far (SIGNUP_HOURLY_CAP=6): two more pass, the next is refused
    expect((await signup({ family_name: 'Five', email: 'five@example.test' })).statusCode).toBe(202);
    expect((await signup({ family_name: 'Six', email: 'six@example.test' })).statusCode).toBe(202);
    const over = await signup({ family_name: 'Seven', email: 'seven@example.test' });
    expect(over.statusCode).toBe(503);
    expect(rowByEmail('seven@example.test')).toHaveLength(0);
    expect(sent.map((m) => m.to)).not.toContain('seven@example.test');
  });
});

describe('the reaper', () => {
  const age = (familyId: string, days: number) => {
    const past = new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    new Database(join(env.dataDir, 'registry.db')).prepare('UPDATE families SET created_at = ? WHERE id = ?').run(past, familyId);
    const db = familyDb(familyId);
    db.prepare("UPDATE invites SET expires_at = ? WHERE role = 'admin'").run(past);
    db.close();
  };
  const status = (familyId: string) =>
    (registry().prepare('SELECT status FROM families WHERE id = ?').get(familyId) as { status: string }).status;

  it('removes an unclaimed sign-up family once its invitation is a day past expiry, and nothing else', () => {
    const unclaimed = rowByEmail('home@example.test')[0]!.id;
    const claimed = rowByEmail('sam@example.test').find((r) => r.slug.startsWith('petrovy-'))!.id;
    const young = rowByEmail('six@example.test')[0]!.id;
    age(unclaimed, 9);
    age(claimed, 9); // has an administrator — stays
    // an operator-created family, never signed up, with no user: stays
    const { familyId: operators } = tenants.createFamily('operators-qa01');
    new Database(join(env.dataDir, 'registry.db')).prepare('UPDATE families SET created_at = ? WHERE id = ?').run('2020-01-01 00:00:00', operators);

    expect(reapUnclaimedFamilies()).toBe(1);
    expect(status(unclaimed)).toBe('deleted');
    expect(status(claimed)).toBe('active');
    expect(status(young)).toBe('active');
    expect(status(operators)).toBe('active');
    // a second pass finds nothing
    expect(reapUnclaimedFamilies()).toBe(0);
  });
});

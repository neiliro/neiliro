import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

/*
  The founder invitation (#157): a hosted family meets its hub through a
  token the service mailed, not through whoever opens the URL first.

  Same env dance and mail stub as password-reset.test.ts: env.ts reads the
  flags at import time, and the mail provider is a fetch to Mailgun.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';
process.env.MAILGUN_API_KEY = 'test-api-key';

interface Sent {
  to: string;
  subject: string;
  text: string;
}
const sent: Sent[] = [];

vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: FormData }) => {
    const f = (k: string) => String(init.body.get(k) ?? '');
    sent.push({ to: f('to'), subject: f('subject'), text: f('text') });
    return { ok: true, status: 200, json: async () => ({ id: '<sent@mail.neiliro.test>' }) };
  }),
);

const tenants = await import('../lib/tenants.js');
const founder = await import('../lib/founder.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');

afterAll(() => {
  for (const k of ['HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY', 'MAILGUN_API_KEY'])
    delete process.env[k];
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

let app: FastifyInstance;

const onHost = (slug: string) => ({ host: `${slug}.neiliro.test` });
const PASSWORD = 'correct horse battery';

function tokenFrom(mail: Sent): string {
  return new URL(mail.text.match(/https:\/\/\S+\/join\?\S+/)![0]).searchParams.get('token')!;
}

function familyDb(familyId: string) {
  return new Database(join(env.dataDir, 'families', familyId, 'hub.db'));
}

describe('the founder invitation', () => {
  beforeAll(async () => {
    tenants.initHosted();
    app = await buildApp();
  });

  it('mails a single-use link that opens the first run once, with the address confirmed', async () => {
    const { familyId } = tenants.createFamily('founders-f1a1');
    const invite = await founder.issueFounderInvite(familyId, 'Sam@Example.test');
    expect(invite.mailed).toBe(true);
    const mail = sent.at(-1)!;
    expect(mail.to).toBe('sam@example.test');
    expect(mail.text).toContain('https://founders-f1a1.neiliro.test/join?token=');
    const token = tokenFrom(mail);
    expect(invite.url).toContain(token);

    // From outside the family now looks set up — the bare URL shows the
    // sign-in screen, not a first-run form that would only answer 403
    const state = await app.inject({ url: '/api/auth/state', headers: onHost('founders-f1a1') });
    expect(state.json().initialized).toBe(true);

    // The bare URL opens nothing now
    const bare = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('founders-f1a1'),
      payload: { accept_terms: true, name: 'Squatter', email: 'squatter@example.test', password: PASSWORD },
    });
    expect(bare.statusCode).toBe(403);
    // Word-for-word what a ghost says — see the enumeration test below
    expect(bare.json().error).toBe('The hub is already set up');

    // The link tells the founder which address it came to
    const check = await app.inject({
      url: `/api/auth/invite?token=${token}`,
      headers: onHost('founders-f1a1'),
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({ valid: true, role: 'admin', email: 'sam@example.test' });

    // A token issued for one family opens nothing on another
    const { familyId: otherId } = tenants.createFamily('others-f1a2');
    const elsewhere = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('others-f1a2'),
      payload: { accept_terms: true, token, name: 'Sam', email: 'sam@example.test', password: PASSWORD },
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(familyDb(otherId).prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });

    const mailsBefore = sent.length;
    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('founders-f1a1'),
      payload: {
        accept_terms: true,
        token,
        name: 'Sam',
        email: 'sam@example.test',
        password: PASSWORD,
        timezone: 'America/Chicago',
      },
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.cookies.find((c) => c.name === 'hub_session')).toBeDefined();

    const db = familyDb(familyId);
    const admin = db
      .prepare('SELECT role, email, email_verified_at FROM users')
      .get() as { role: string; email: string; email_verified_at: string | null };
    expect(admin.role).toBe('admin');
    expect(admin.email).toBe('sam@example.test');
    // Confirmed by construction: receiving the link was the proof
    expect(admin.email_verified_at).not.toBeNull();
    // ...so no confirmation mail went out for it
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.length).toBe(mailsBefore);
    // The founder's browser set the family's clock, as the open first run does
    expect(db.prepare("SELECT value FROM settings WHERE key = 'home.timezone'").get()).toEqual({
      value: 'America/Chicago',
    });
    db.close();

    // Once: the same link is dead
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('founders-f1a1'),
      payload: { accept_terms: true, token, name: 'Sam II', email: 'sam2@example.test', password: PASSWORD },
    });
    expect(again.statusCode).toBe(404);

    // And password recovery works from day one — the whole point
    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset',
      headers: onHost('founders-f1a1'),
      payload: { email: 'sam@example.test' },
    });
    expect(reset.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.at(-1)!.to).toBe('sam@example.test');
    expect(sent.at(-1)!.text).toContain('/reset?token=');
  });

  it('treats a different login as unproven and asks for confirmation', async () => {
    const { familyId } = tenants.createFamily('movers-f2b1');
    await founder.issueFounderInvite(familyId, 'invited@example.test');
    const token = tokenFrom(sent.at(-1)!);

    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('movers-f2b1'),
      payload: { accept_terms: true, token, name: 'Mo', email: 'other@example.test', password: PASSWORD },
    });
    expect(joined.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 60));

    const db = familyDb(familyId);
    const admin = db.prepare('SELECT email_verified_at FROM users').get() as {
      email_verified_at: string | null;
    };
    db.close();
    expect(admin.email_verified_at).toBeNull();
    expect(sent.at(-1)!.to).toBe('other@example.test');
    expect(sent.at(-1)!.subject).toBe('Confirm your Neiliro address');
  });

  it('re-issues for a family without an administrator and refuses one that has one', async () => {
    const { familyId } = tenants.createFamily('latecomers-f3c1');
    await founder.issueFounderInvite(familyId, 'first@example.test');
    const first = tokenFrom(sent.at(-1)!);
    await founder.issueFounderInvite(familyId, 'second@example.test');
    const second = tokenFrom(sent.at(-1)!);

    // The earlier link is retired by the re-issue
    const stale = await app.inject({ url: `/api/auth/invite?token=${first}`, headers: onHost('latecomers-f3c1') });
    expect(stale.statusCode).toBe(404);
    const live = await app.inject({ url: `/api/auth/invite?token=${second}`, headers: onHost('latecomers-f3c1') });
    expect(live.json().email).toBe('second@example.test');

    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('latecomers-f3c1'),
      payload: { accept_terms: true, token: second, name: 'Lee', email: 'second@example.test', password: PASSWORD },
    });
    expect(joined.statusCode).toBe(201);

    await expect(founder.issueFounderInvite(familyId, 'third@example.test')).rejects.toThrow(
      /already has an administrator/,
    );
    await expect(founder.issueFounderInvite(familyId, 'not an address')).rejects.toThrow(/not an email/);
  });

  it('expires like any invite, and the admin never sees it in the invite list', async () => {
    const { familyId } = tenants.createFamily('sleepers-f4d1');
    await founder.issueFounderInvite(familyId, 'zed@example.test');
    const token = tokenFrom(sent.at(-1)!);

    const db = familyDb(familyId);
    db.prepare("UPDATE invites SET expires_at = datetime('now', '-1 hour')").run();
    db.close();

    const expired = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('sleepers-f4d1'),
      payload: { accept_terms: true, token, name: 'Zed', email: 'zed@example.test', password: PASSWORD },
    });
    expect(expired.statusCode).toBe(404);
    // And the open first run stays closed — an expired invitation is
    // re-issued by the operator, not bypassed
    const bare = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: onHost('sleepers-f4d1'),
      payload: { accept_terms: true, name: 'Zed', email: 'zed@example.test', password: PASSWORD },
    });
    expect(bare.statusCode).toBe(403);

    // A fresh invitation gets them in; the founder invitation is not the
    // admin's to see or revoke afterwards
    await founder.issueFounderInvite(familyId, 'zed@example.test');
    const fresh = tokenFrom(sent.at(-1)!);
    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('sleepers-f4d1'),
      payload: { accept_terms: true, token: fresh, name: 'Zed', email: 'zed@example.test', password: PASSWORD },
    });
    expect(joined.statusCode).toBe(201);
    const cookie = joined.cookies.find((c) => c.name === 'hub_session')!.value;
    const list = await app.inject({
      url: '/api/invites',
      headers: { ...onHost('sleepers-f4d1'), cookie: `hub_session=${cookie}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
  });

  /*
    #185. Closing the open first run introduced a way to enumerate the
    service: the founder branch answered with its own sentence, so one
    unauthenticated POST told a stranger whether a subdomain belonged to a
    real family. The ghost exists to make that impossible, and the state
    endpoint was already careful about it — this is the same promise, on
    the one route that had stopped keeping it.

    The claimed case is the one worth pinning rather than the pending one:
    founderInvited() looks for an admin invite without asking whether it
    was used, so the row outlives the founder's arrival and every family
    on the service would have answered differently from every name that
    was never provisioned, for as long as it existed.
  */
  it('refuses the first run identically for a ghost, a waiting family and a claimed one', async () => {
    const setup = (slug: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/setup',
        headers: onHost(slug),
        payload: { accept_terms: true, name: 'Squatter', email: 'squatter@example.test', password: PASSWORD },
      });

    // 1. A family provisioned with an invitation, founder not yet arrived
    const { familyId } = tenants.createFamily('parity-f5e1');
    await founder.issueFounderInvite(familyId, 'parity@example.test');
    const waiting = await setup('parity-f5e1');

    // 2. A subdomain nobody ever provisioned
    const ghost = await setup('no-such-family-f5e2');

    // 3. The same family after its founder has claimed it — the used
    //    admin invite row is still there, which is what made this leak
    //    permanent rather than a window
    const token = tokenFrom(sent.at(-1)!);
    const joined = await app.inject({
      method: 'POST',
      url: '/api/auth/join',
      headers: onHost('parity-f5e1'),
      payload: { accept_terms: true, token, name: 'Parity', email: 'parity@example.test', password: PASSWORD },
    });
    expect(joined.statusCode).toBe(201);
    const claimed = await setup('parity-f5e1');

    for (const res of [waiting, ghost, claimed]) expect(res.statusCode).toBe(403);
    expect(waiting.json()).toEqual(ghost.json());
    expect(claimed.json()).toEqual(ghost.json());

    // And the sign-in screen still cannot tell them apart either
    const state = (slug: string) =>
      app.inject({ url: '/api/auth/state', headers: onHost(slug) }).then((r) => r.json());
    expect(await state('parity-f5e1')).toEqual(await state('no-such-family-f5e2'));
  });
});

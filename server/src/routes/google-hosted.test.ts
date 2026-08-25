import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/*
  Google sign-in in hosted mode: one callback host for every family, and a
  single-use ticket that hands the browser back to the family's own
  subdomain (routes/google.ts). What is worth testing here is not the happy
  path alone but the three refusals the hand-back exists to make — a ticket
  on the wrong family, a ticket without the browser that started the flow,
  and a ticket used twice — plus the rule that the sign-in screen must look
  the same on a ghost as on a real family.

  env.ts reads the environment at import time, so the flags are set before
  any app module is pulled in.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');
const { default: Database } = await import('better-sqlite3');
const { join } = await import('node:path');

const FAMILY = 'smiths-g1h2.neiliro.test';
const OTHER = 'jones-g3h4.neiliro.test';
const GHOST = 'nobody-z9y8.neiliro.test';
const AUTH = 'auth.neiliro.test';
const GOOGLE_SUB = '1234567890-google-sub';

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

/** Google's two endpoints, faked: the code always resolves to one account. */
function stubGoogle(sub = GOOGLE_SUB): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes('token')
          ? { access_token: 'token-from-google' }
          : { sub, email: 'sam@gmail.test' },
    })),
  );
}

let app: FastifyInstance;

/** Start a sign-in on `host` and return the state, the cookie and where we were sent. */
async function start(host: string): Promise<{ state: string; cookie: string; location: string }> {
  const res = await app.inject({ url: '/api/auth/google/start', headers: { host } });
  const location = res.headers.location as string;
  const cookie = res.cookies.find((c) => c.name === 'hub_oauth');
  return {
    state: cookie?.value ?? '',
    cookie: cookie ? `hub_oauth=${cookie.value}` : '',
    location,
  };
}

/** Walk the callback on the auth host and return the hand-back URL it issues. */
async function callback(state: string): Promise<string> {
  const res = await app.inject({
    url: `/api/auth/google/callback?state=${encodeURIComponent(state)}&code=code-from-google`,
    headers: { host: AUTH },
  });
  expect(res.statusCode).toBe(302);
  return res.headers.location as string;
}

beforeAll(async () => {
  tenants.initHosted();
  const family = tenants.createFamily('smiths-g1h2');
  tenants.createFamily('jones-g3h4');
  app = await buildApp();

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: FAMILY },
    payload: { name: 'Sam', email: 'sam@smiths.test', password: 'correct horse battery' },
  });
  expect(created.statusCode).toBe(201);

  // A second family with its own admin: linking is per-family, and a
  // ticket carried across subdomains has somewhere real to be refused.
  const dana = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: OTHER },
    payload: { name: 'Dana', email: 'dana@jones.test', password: 'correct horse battery' },
  });
  expect(dana.statusCode).toBe(201);

  // Linked by hand, straight in the family's file: linking is its own flow
  // (tested below), and the sign-in tests need an account that already
  // carries a google_sub.
  const file = new Database(join(env.dataDir, 'families', family.familyId, 'hub.db'));
  file.prepare('UPDATE users SET google_sub = ? WHERE email = ?').run(GOOGLE_SUB, 'sam@smiths.test');
  file.close();
});

describe('hosted google sign-in', () => {
  it('sends every family to one callback host, and looks the same on a ghost', async () => {
    const real = await start(FAMILY);
    const ghost = await start(GHOST);

    for (const { location, state } of [real, ghost]) {
      const url = new URL(location);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://auth.neiliro.test/api/auth/google/callback',
      );
      expect(url.searchParams.get('state')).toBe(state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    }
  });

  it('offers the button identically on a ghost and on a real family', async () => {
    const real = await app.inject({ url: '/api/auth/state', headers: { host: FAMILY } });
    const ghost = await app.inject({ url: '/api/auth/state', headers: { host: GHOST } });
    expect(real.json().google).toBe(true);
    expect(ghost.json()).toEqual(real.json());
  });

  it('refuses a callback that arrives anywhere but the callback host', async () => {
    stubGoogle();
    const { state } = await start(FAMILY);
    const res = await app.inject({
      url: `/api/auth/google/callback?state=${encodeURIComponent(state)}&code=code-from-google`,
      headers: { host: FAMILY },
    });
    expect(res.headers.location).toBe('/?google=error');
  });

  it('signs in on the family host after the hand-back', async () => {
    stubGoogle();
    const { state, cookie } = await start(FAMILY);
    const handback = new URL(await callback(state));
    expect(handback.host).toBe(FAMILY);
    expect(handback.pathname).toBe('/api/auth/google/finish');

    const finish = await app.inject({
      url: handback.pathname + handback.search,
      headers: { host: FAMILY, cookie },
    });
    expect(finish.headers.location).toBe('/');
    const session = finish.cookies.find((c) => c.name === 'hub_session');
    expect(session?.value).toBeTruthy();

    // ...and the session is real, in that family's database
    const me = await app.inject({
      url: '/api/tasks',
      headers: { host: FAMILY, cookie: `hub_session=${session!.value}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('refuses a ticket redeemed on another family, without the cookie, or twice', async () => {
    stubGoogle();

    // On another family's subdomain: the ticket names the family it was for
    const first = await start(FAMILY);
    const stolen = new URL(await callback(first.state));
    const elsewhere = await app.inject({
      url: stolen.pathname + stolen.search,
      headers: { host: OTHER, cookie: first.cookie },
    });
    expect(elsewhere.headers.location).toBe('/?google=error');
    expect(elsewhere.cookies.find((c) => c.name === 'hub_session')).toBeUndefined();

    // Without the cookie of the browser that started the flow
    const second = await start(FAMILY);
    const noCookie = new URL(await callback(second.state));
    const bare = await app.inject({
      url: noCookie.pathname + noCookie.search,
      headers: { host: FAMILY },
    });
    expect(bare.headers.location).toBe('/?google=error');
    expect(bare.cookies.find((c) => c.name === 'hub_session')).toBeUndefined();

    // Twice: a redeemed ticket is gone, and so is a refused one
    const third = await start(FAMILY);
    const once = new URL(await callback(third.state));
    const ok = await app.inject({
      url: once.pathname + once.search,
      headers: { host: FAMILY, cookie: third.cookie },
    });
    expect(ok.headers.location).toBe('/');
    const again = await app.inject({
      url: once.pathname + once.search,
      headers: { host: FAMILY, cookie: third.cookie },
    });
    expect(again.headers.location).toBe('/?google=error');
  });

  it('lets a Google account that nobody linked no further than the family door', async () => {
    stubGoogle('a-stranger-sub');
    const { state, cookie } = await start(FAMILY);
    const handback = new URL(await callback(state));
    const finish = await app.inject({
      url: handback.pathname + handback.search,
      headers: { host: FAMILY, cookie },
    });
    expect(finish.headers.location).toBe('/?google=not_linked');
    expect(finish.cookies.find((c) => c.name === 'hub_session')).toBeUndefined();
  });

  it('links an account from its own settings, and only for the session that asked', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: OTHER },
      payload: { email: 'dana@jones.test', password: 'correct horse battery' },
    });
    const session = login.cookies.find((c) => c.name === 'hub_session')!;

    stubGoogle('dana-google-sub');
    const started = await app.inject({
      url: '/api/auth/google/link',
      headers: { host: OTHER, cookie: `hub_session=${session.value}` },
    });
    const state = started.cookies.find((c) => c.name === 'hub_oauth')!.value;
    const handback = new URL(await callback(state));
    expect(handback.host).toBe(OTHER);

    // Without the session the link cannot be completed, even with the ticket
    const anonymous = await app.inject({
      url: handback.pathname + handback.search,
      headers: { host: OTHER, cookie: `hub_oauth=${state}` },
    });
    expect(anonymous.headers.location).toBe('/settings?google=error');

    // With it, the link lands — and stays inside this family
    stubGoogle('dana-google-sub');
    const retry = await app.inject({
      url: '/api/auth/google/link',
      headers: { host: OTHER, cookie: `hub_session=${session.value}` },
    });
    const retryState = retry.cookies.find((c) => c.name === 'hub_oauth')!.value;
    const second = new URL(await callback(retryState));
    const linked = await app.inject({
      url: second.pathname + second.search,
      headers: { host: OTHER, cookie: `hub_oauth=${retryState}; hub_session=${session.value}` },
    });
    expect(linked.headers.location).toBe('/settings?google=linked');

    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: FAMILY },
      payload: { email: 'dana@jones.test', password: 'correct horse battery' },
    });
    expect(signedIn.statusCode).toBe(401); // Dana exists in one family only
  });

  it('answers a ghost exactly as it answers an unlinked account on a real family', async () => {
    stubGoogle();
    const { state, cookie } = await start(GHOST);
    const handback = new URL(await callback(state));
    expect(handback.host).toBe(GHOST);
    const finish = await app.inject({
      url: handback.pathname + handback.search,
      headers: { host: GHOST, cookie },
    });
    expect(finish.headers.location).toBe('/?google=not_linked');
  });
});

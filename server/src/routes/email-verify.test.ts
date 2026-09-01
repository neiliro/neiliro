import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/*
  Confirming the login address (routes/email-verify.ts).

  This exists to make the hosted password reset safe. The login was always
  an address in shape only — nothing proved ownership — and that was
  harmless until a forgotten password could be recovered through it: a
  typo at signup would mail a working reset link to a stranger, one click
  from a family's data. So the reset is gated on a confirmation, and the
  cases below are the ones that gate has to get right.
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
    return { ok: true, status: 200, json: async () => ({ id: '<x@mail.neiliro.test>' }) };
  }),
);

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');

const SLUG = 'smiths-v1w2';
const HOST = `${SLUG}.neiliro.test`;
const ADMIN = 'sam@smiths-v1w2.test';
const MEMBER = 'dana@smiths-v1w2.test';

afterAll(() => {
  for (const k of ['HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY', 'MAILGUN_API_KEY'])
    delete process.env[k];
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

let app: FastifyInstance;
let adminCookie: string;
let memberId: string;

/** Wait for the detached mail, then take the whole link out of the last one. */
async function lastLink(subject: string): Promise<URL | null> {
  await new Promise((r) => setTimeout(r, 60));
  const mail = [...sent].reverse().find((m) => m.subject === subject);
  if (!mail) return null;
  return new URL(mail.text.match(/https:\/\/\S+/)![0]);
}

/** Wait for the detached mail, then take the token out of the last one. */
async function lastToken(subject: string): Promise<string | null> {
  return (await lastLink(subject))?.searchParams.get('token') ?? null;
}

function requestReset(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/password-reset',
    headers: { host: HOST },
    payload: { email },
  });
}

beforeAll(async () => {
  tenants.initHosted();
  tenants.createFamily(SLUG);
  app = await buildApp();

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: HOST },
    payload: { name: 'Sam', email: ADMIN, password: 'correct horse battery' },
  });
  expect(created.statusCode).toBe(201);
  adminCookie = `hub_session=${created.cookies.find((c) => c.name === 'hub_session')?.value}`;

  // A second account, joined by invite and left unconfirmed on purpose
  const invited = await app.inject({
    method: 'POST',
    url: '/api/invites',
    headers: { host: HOST, cookie: adminCookie },
    payload: { role: 'member' },
  });
  const token = (invited.json() as { path: string }).path.split('token=')[1]!;
  const joined = await app.inject({
    method: 'POST',
    url: '/api/auth/join',
    headers: { host: HOST },
    payload: { token, name: 'Dana', email: MEMBER, password: 'correct horse battery' },
  });
  expect(joined.statusCode).toBe(201);

  const users = await app.inject({ url: '/api/users', headers: { host: HOST, cookie: adminCookie } });
  memberId = (users.json() as { id: string; email: string }[]).find((u) => u.email === MEMBER)!.id;
  sent.length = 0;
});

describe('address confirmation', () => {
  it('does not mail a reset to an address nobody confirmed', async () => {
    // The whole reason this feature exists. Dana never opened a
    // confirmation link, so her address is not proof of anything — and a
    // typo'd one would belong to a stranger.
    const before = sent.length;
    expect((await requestReset(MEMBER)).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(before);
  });

  /*
    Found in production: the confirmation link was built from HOSTED_DOMAIN
    alone, so it pointed at the apex. On our own service that is the
    landing site — it has no such route, served its front page, and the
    address stayed unconfirmed with nothing to say so.

    The old tests parsed this same link and kept only the token, which is
    why they passed throughout. The reset link is the same shape and is
    pinned too, further down — either one landing off the family is a dead
    end for whoever is holding the mail.
  */
  it('sends the confirmation link to the family, not to the apex', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/profile/email-verify',
      headers: { host: HOST, cookie: adminCookie },
      payload: {},
    });
    const confirm = await lastLink('Confirm your Neiliro address');
    expect(confirm?.host).toBe(HOST);
    expect(confirm?.pathname).toBe('/verify-email');
  });

  it('confirms an address once, and the reset starts working', async () => {
    // Ask for the link the way the prompt in the UI does
    const asked = await app.inject({
      method: 'POST',
      url: '/api/profile/email-verify',
      headers: { host: HOST, cookie: adminCookie },
      payload: {},
    });
    expect(asked.statusCode).toBe(200);

    const token = await lastToken('Confirm your Neiliro address');
    expect(token).toBeTruthy();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/email-verify',
      headers: { host: HOST },
      payload: { token },
    });
    expect(ok.statusCode).toBe(200);

    // Single use
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/email-verify',
      headers: { host: HOST },
      payload: { token },
    });
    expect(again.statusCode).toBe(400);

    // ...and now a reset does go out
    sent.length = 0;
    expect((await requestReset(ADMIN)).statusCode).toBe(202);
    const reset = await lastLink('Reset your Neiliro password');
    expect(reset?.searchParams.get('token')).toBeTruthy();
    // Same rule as the confirmation link: it has to open on the family
    expect(reset?.host).toBe(HOST);
    expect(reset?.pathname).toBe('/reset');
  });

  it('un-confirms the address when an administrator changes it', async () => {
    // The proof belonged to the address, not to the account
    sent.length = 0;
    const moved = await app.inject({
      method: 'POST',
      url: `/api/users/${memberId}/email`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { email: 'dana.fixed@smiths-v1w2.test' },
    });
    expect(moved.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 60));

    // The new address arrives unconfirmed, with a confirmation waiting
    expect(
      sent.some(
        (m) => m.to === 'dana.fixed@smiths-v1w2.test' && m.subject === 'Confirm your Neiliro address',
      ),
    ).toBe(true);

    // ...and the old address is nobody's login any more
    const beforeReset = sent.length;
    expect((await requestReset(MEMBER)).statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(beforeReset);
  });

  it('tells the People list which addresses are still unproven', async () => {
    /*
      The administrator's own screen is where a typo gets noticed, so the
      list has to carry the state — otherwise the only way to see that an
      address was never confirmed is to watch a password reset silently
      not arrive. Sam confirmed above; Dana was just moved to a fresh
      address by the case before this one.
    */
    const list = await app.inject({
      url: '/api/users',
      headers: { host: HOST, cookie: adminCookie },
    });
    const users = list.json() as { email: string; email_verified: boolean | null }[];
    expect(users.find((u) => u.email === ADMIN)?.email_verified).toBe(true);
    expect(users.find((u) => u.email === 'dana.fixed@smiths-v1w2.test')?.email_verified).toBe(false);
  });

  it('refuses a stale confirmation issued for a previous address', async () => {
    // The link mailed to dana.fixed in the previous case, still unopened
    const stale = await lastToken('Confirm your Neiliro address');
    expect(stale).toBeTruthy();

    // Move again before the link is opened
    await app.inject({
      method: 'POST',
      url: `/api/users/${memberId}/email`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { email: 'dana.final@smiths-v1w2.test' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/email-verify',
      headers: { host: HOST },
      payload: { token: stale },
    });
    // Confirming the old address must not mark the new one proven
    expect(res.statusCode).toBe(400);
  });

  it('refuses an address another member already uses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${memberId}/email`,
      headers: { host: HOST, cookie: adminCookie },
      payload: { email: ADMIN },
    });
    expect(res.statusCode).toBe(409);
  });

  it('lets only an administrator move an address', async () => {
    const memberLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: HOST },
      payload: { email: 'dana.final@smiths-v1w2.test', password: 'correct horse battery' },
    });
    const cookie = `hub_session=${memberLogin.cookies.find((c) => c.name === 'hub_session')?.value}`;

    // A stolen session must not be able to move the account to another
    // mailbox and then "recover" it from there
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${memberId}/email`,
      headers: { host: HOST, cookie },
      payload: { email: 'attacker@elsewhere.test' },
    });
    expect(res.statusCode).toBe(403);
  });
});

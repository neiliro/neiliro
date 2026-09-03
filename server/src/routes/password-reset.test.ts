import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

/*
  Password reset by email — hosted only (routes/password-reset.ts).

  The happy path matters least. What this flow must get right is what it
  refuses to say and what it refuses to change: it never reveals whether a
  login exists, it does not resurrect password sign-in for someone who
  turned it off, and it leaves the second factor alone — otherwise a
  mailbox becomes a way around TOTP.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';
process.env.MAILGUN_API_KEY = 'test-api-key';

interface Sent {
  from: string;
  to: string;
  subject: string;
  text: string;
  tracking: string;
}
const sent: Sent[] = [];

vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: FormData }) => {
    const f = (k: string) => String(init.body.get(k) ?? '');
    sent.push({ from: f('from'), to: f('to'), subject: f('subject'), text: f('text'), tracking: f('o:tracking') });
    return { ok: true, status: 200, json: async () => ({ id: '<sent@mail.neiliro.test>' }) };
  }),
);

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');

const SLUG = 'smiths-r1s2';
const HOST = `${SLUG}.neiliro.test`;
const EMAIL = 'sam@smiths-r1s2.test';
const OLD_PASSWORD = 'correct horse battery';

afterAll(() => {
  for (const k of ['HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY', 'MAILGUN_API_KEY'])
    delete process.env[k];
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

let app: FastifyInstance;
let familyId: string;

function familyDb() {
  return new Database(join(env.dataDir, 'families', familyId, 'hub.db'));
}

/** Ask for a reset and return the token out of the emailed link. */
async function requestReset(email = EMAIL): Promise<string | null> {
  const before = sent.length;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/password-reset',
    headers: { host: HOST },
    payload: { email },
  });
  // Always 202, whatever the address
  expect(res.statusCode).toBe(202);
  // The mail is sent detached from the response; give it a tick
  await new Promise((r) => setTimeout(r, 60));
  if (sent.length === before) return null;
  return new URL(sent[sent.length - 1]!.text.match(/https:\/\/\S+/)![0]).searchParams.get('token');
}

function signIn(password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: HOST },
    payload: { email: EMAIL, password },
  });
}

beforeAll(async () => {
  tenants.initHosted();
  familyId = tenants.createFamily(SLUG).familyId;
  app = await buildApp();
  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: HOST },
    payload: { name: 'Sam', email: EMAIL, password: OLD_PASSWORD },
  });
  expect(created.statusCode).toBe(201);

  /*
    Signing up now also mails a confirmation, and a reset is only ever sent
    to a confirmed address — an unproven one would turn a signup typo into
    a stranger's way into the family. Walk that flow rather than writing the
    column: it is the same path a person takes, and it keeps this file
    honest about the precondition.
  */
  await new Promise((r) => setTimeout(r, 60));
  const invite = sent[sent.length - 1]!;
  expect(invite.subject).toBe('Confirm your Neiliro address');
  const verifyToken = new URL(invite.text.match(/https:\/\/\S+/)![0]).searchParams.get('token');
  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/auth/email-verify',
    headers: { host: HOST },
    payload: { token: verifyToken },
  });
  expect(confirmed.statusCode).toBe(200);
  sent.length = 0;
});

describe('password reset', () => {
  it('mails a single-use link from the service address, and the new password works', async () => {
    const token = await requestReset();
    expect(token).toBeTruthy();

    const mail = sent[sent.length - 1]!;
    // A service sender, not the family's own address: a reset notice in the
    // shared family inbox would tell everyone that someone is recovering
    expect(mail.from).toContain('<no-reply@mail.neiliro.test>');
    expect(mail.to).toBe(EMAIL);
    expect(mail.text).toContain(`https://${SLUG}.neiliro.test/reset?token=`);
    // Service mail rides the same Mailgun call as family replies, so the
    // no-tracking promise has to hold here too (#158)
    expect(mail.tracking).toBe('no');

    const done = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { host: HOST },
      payload: { token, password: 'a whole new passphrase' },
    });
    expect(done.statusCode).toBe(204);

    expect((await signIn('a whole new passphrase')).statusCode).toBe(200);
    expect((await signIn(OLD_PASSWORD)).statusCode).toBe(401);

    // Single use
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { host: HOST },
      payload: { token, password: 'yet another passphrase' },
    });
    expect(again.statusCode).toBe(400);
  });

  it('answers an unknown address exactly the same, and sends nothing', async () => {
    const before = sent.length;
    const token = await requestReset('nobody@elsewhere.test');
    expect(token).toBeNull();
    expect(sent).toHaveLength(before);
  });

  it('closes every existing session', async () => {
    const signedIn = await signIn('a whole new passphrase');
    const cookie = `hub_session=${signedIn.cookies.find((c) => c.name === 'hub_session')?.value}`;
    expect((await app.inject({ url: '/api/auth/me', headers: { host: HOST, cookie } })).statusCode).toBe(200);

    const token = await requestReset();
    await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { host: HOST },
      payload: { token, password: 'third passphrase entirely' },
    });

    // A reset is also how someone evicts an intruder
    const after = await app.inject({ url: '/api/auth/me', headers: { host: HOST, cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('leaves the second factor alone', async () => {
    const db = familyDb();
    db.prepare('UPDATE users SET totp_secret = ? WHERE email = ?').run('JBSWY3DPEHPK3PXP', EMAIL);
    db.close();

    const token = await requestReset();
    const done = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { host: HOST },
      payload: { token, password: 'fourth passphrase here' },
    });
    expect(done.statusCode).toBe(204);

    const db2 = familyDb();
    const row = db2.prepare('SELECT totp_secret FROM users WHERE email = ?').get(EMAIL) as {
      totp_secret: string | null;
    };
    db2.close();
    // Otherwise a mailbox would be a way around the second factor
    expect(row.totp_secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses an expired link', async () => {
    const token = await requestReset();
    const db = familyDb();
    db.prepare("UPDATE password_resets SET expires_at = '2020-01-01T00:00:00.000Z' WHERE used_at IS NULL").run();
    db.close();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      headers: { host: HOST },
      payload: { token, password: 'expired attempt passphrase' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('sends nothing to a member who turned password sign-in off', async () => {
    const db = familyDb();
    db.prepare('UPDATE users SET password_login_disabled = 1 WHERE email = ?').run(EMAIL);
    db.close();

    const before = sent.length;
    const token = await requestReset();
    // Silence, and the same 202 — turning password login back on behind
    // someone's back would undo a deliberate choice
    expect(token).toBeNull();
    expect(sent).toHaveLength(before);

    const db2 = familyDb();
    db2.prepare('UPDATE users SET password_login_disabled = 0 WHERE email = ?').run(EMAIL);
    db2.close();
  });
});

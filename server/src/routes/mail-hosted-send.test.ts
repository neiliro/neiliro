import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/*
  Replying from a hosted family (lib/mail.ts, outgoing()).

  A hosted family has no mail_account: the service hands it an address and
  the reply goes out over Mailgun's HTTP API — not SMTP, because the
  provider blocks outbound 25/465/587 (see lib/mail.ts). What is worth
  pinning down is the From header: it must be the family's own address,
  derived from the slug, never the credential the service authenticates
  with. Get that wrong and every family answers as the service.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';
process.env.MAILGUN_API_KEY = 'test-api-key';
process.env.MAILGUN_API_BASE = 'https://api.eu.mailgun.test';

interface Captured {
  url: string;
  auth: string | null;
  fields: Record<string, string>;
}
const sent: Captured[] = [];
let failNext: { status: number; body: string } | null = null;

/** Mailgun's send endpoint, faked — and recorded. */
function stubMailgun(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: FormData }) => {
      const fields: Record<string, string> = {};
      for (const [key, value] of init.body.entries()) fields[key] = String(value);
      sent.push({ url: String(url), auth: init.headers.Authorization ?? null, fields });
      if (failNext) {
        const { status, body } = failNext;
        failNext = null;
        return { ok: false, status, text: async () => body };
      }
      return { ok: true, status: 200, json: async () => ({ id: '<sent@mail.neiliro.test>' }) };
    }),
  );
}

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');

const SLUG = 'smiths-s1t2';
const HOST = `${SLUG}.neiliro.test`;

afterAll(() => {
  for (const key of [
    'HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY',
    'MAILGUN_API_KEY', 'MAILGUN_API_BASE',
  ]) delete process.env[key];
  vi.unstubAllGlobals();
  tenants.shutdownHosted();
});

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  stubMailgun();
  tenants.initHosted();
  tenants.createFamily(SLUG);
  app = await buildApp();

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: HOST },
    payload: { name: 'Sam', email: 'sam@smiths.test', password: 'correct horse battery' },
  });
  expect(created.statusCode).toBe(201);
  cookie = `hub_session=${created.cookies.find((c) => c.name === 'hub_session')?.value ?? ''}`;

  // A letter to reply to, delivered the way real ones arrive
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = 'a'.repeat(50);
  const delivered = await app.inject({
    method: 'POST',
    url: '/api/mail/inbound/mime',
    headers: { host: 'in.neiliro.test', 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      timestamp,
      token,
      signature: createHmac('sha256', 'test-signing-key').update(timestamp + token).digest('hex'),
      recipient: `${SLUG}@mail.neiliro.test`,
      'body-mime': [
        'Message-ID: <consent-9@school.example>',
        'From: "Riverside School" <office@school.example>',
        `To: ${SLUG}@mail.neiliro.test`,
        'Subject: Consent form',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please confirm by Friday.',
        '',
      ].join('\r\n'),
    }).toString(),
  });
  expect(delivered.statusCode).toBe(200);

  // Signing up mails an address confirmation; this file is about replies,
  // so drop it rather than counting around it.
  await new Promise((r) => setTimeout(r, 60));
  sent.length = 0;
});

describe('hosted reply', () => {
  it('sends from the family address, with the sender in the display name', async () => {
    const list = await app.inject({ url: '/api/mail', headers: { host: HOST, cookie } });
    const [message] = (list.json() as { messages: { id: string }[] }).messages;

    const res = await app.inject({
      method: 'POST',
      url: `/api/mail/${message!.id}/reply`,
      headers: { host: HOST, cookie },
      payload: { text: 'Confirmed, thank you.' },
    });
    expect(res.statusCode).toBe(201);

    expect(sent).toHaveLength(1);
    const { url, auth, fields } = sent[0]!;

    // The regional endpoint and the family's own domain
    expect(url).toBe('https://api.eu.mailgun.test/v3/mail.neiliro.test/messages');
    expect(auth).toBe(`Basic ${Buffer.from('api:test-api-key').toString('base64')}`);

    // Sent AS the family — the API key only says who we are to Mailgun
    expect(fields.from).toContain(`<${SLUG}@mail.neiliro.test>`);
    expect(fields.to).toBe('office@school.example');
    expect(fields.subject).toBe('Re: Consent form');
    // Threading headers ride as custom "h:" fields on this API,
    // angle-bracketed the way the header is stored
    expect(fields['h:In-Reply-To']).toBe('<consent-9@school.example>');
    expect(fields['h:References']).toBe('<consent-9@school.example>');
  });

  it('encodes the display name, which is never plain ASCII', async () => {
    // "Sam · <address>" — the separator alone puts every reply outside
    // ASCII, so a raw header would be malformed before anyone is called
    // Денис. RFC 2047, base64.
    const { fields } = sent[0]!;
    const [encoded] = fields.from!.split(' <');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const decoded = Buffer.from(encoded!.slice(10, -2), 'base64').toString('utf8');
    expect(decoded).toBe(`Sam · ${SLUG}@mail.neiliro.test`);
  });

  it('files the sent copy under the family address, so the thread reads in one place', async () => {
    const detail = await app.inject({
      url: '/api/mail',
      headers: { host: HOST, cookie },
    });
    const [message] = (detail.json() as { messages: { id: string }[] }).messages;
    const thread = await app.inject({
      url: `/api/mail/${message!.id}`,
      headers: { host: HOST, cookie },
    });
    const replies = (thread.json() as { replies: { body_text: string; sent_by_name: string }[] }).replies;
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body_text).toBe('Confirmed, thank you.');
    expect(replies[0]!.sent_by_name).toBe('Sam');
  });

  it('does not file a copy when Mailgun refuses the message', async () => {
    // The realistic refusal: sending held for compliance. The letter did
    // not go out, so the thread must not claim it did.
    failNext = { status: 403, body: 'Domain is not allowed to send' };

    const list = await app.inject({ url: '/api/mail', headers: { host: HOST, cookie } });
    const [message] = (list.json() as { messages: { id: string }[] }).messages;
    const before = sent.length;

    const res = await app.inject({
      method: 'POST',
      url: `/api/mail/${message!.id}/reply`,
      headers: { host: HOST, cookie },
      payload: { text: 'This one should not be filed.' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(sent).toHaveLength(before + 1);

    const thread = await app.inject({
      url: `/api/mail/${message!.id}`,
      headers: { host: HOST, cookie },
    });
    const replies = (thread.json() as { replies: { body_text: string }[] }).replies;
    expect(replies.map((r) => r.body_text)).not.toContain('This one should not be filed.');
  });
});

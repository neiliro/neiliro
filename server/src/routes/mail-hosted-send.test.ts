import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/*
  Replying from a hosted family (lib/mail.ts, outgoing()).

  A hosted family has no mail_account: the service hands it an address and
  the reply goes through the service's SMTP. The thing worth pinning down
  is the From header — it must be the family's own address, derived from
  the slug, never the SMTP user the service authenticates as. Get that
  wrong and every family answers as the service.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';
process.env.MAIL_SMTP_HOST = 'smtp.eu.mailgun.test';
process.env.MAIL_SMTP_USER = 'postmaster@mail.neiliro.test';
process.env.MAIL_SMTP_PASS = 'smtp-secret';

interface SentMail {
  from: { name: string; address: string };
  to: string;
  subject: string;
  inReplyTo?: string;
}
const sent: SentMail[] = [];

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: unknown) => ({
      options: opts,
      sendMail: async (mail: SentMail) => {
        sent.push(mail);
        return { messageId: '<sent@mail.neiliro.test>' };
      },
    }),
  },
}));

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');

const SLUG = 'smiths-s1t2';
const HOST = `${SLUG}.neiliro.test`;

afterAll(() => {
  for (const key of [
    'HOSTED_MODE', 'HOSTED_DOMAIN', 'MAIL_DOMAIN', 'MAILGUN_SIGNING_KEY',
    'MAIL_SMTP_HOST', 'MAIL_SMTP_USER', 'MAIL_SMTP_PASS',
  ]) delete process.env[key];
  tenants.shutdownHosted();
});

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
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
    // The family's own address — not MAIL_SMTP_USER, which is only how
    // the service authenticates to the relay
    expect(sent[0]!.from.address).toBe(`${SLUG}@mail.neiliro.test`);
    expect(sent[0]!.from.name).toBe(`Sam · ${SLUG}@mail.neiliro.test`);
    expect(sent[0]!.to).toBe('office@school.example');
    expect(sent[0]!.subject).toBe('Re: Consent form');
    // Angle-bracketed, the way the header is stored and the way
    // In-Reply-To must go out
    expect(sent[0]!.inReplyTo).toBe('<consent-9@school.example>');
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
});

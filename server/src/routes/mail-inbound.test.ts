import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

/*
  Inbound family mail over the Mailgun webhook (routes/mail-inbound.ts).

  The happy path matters least here. What this route exists to get right
  is the refusals: an unsigned delivery, a letter for a family that does
  not exist, and a route whose URL stopped ending in "mime" — each of
  which must be a permanent 406 rather than a 5xx, because Mailgun retries
  anything else for eight hours. Plus the one invariant a mail router
  cannot get wrong twice: a letter lands in exactly one family's database.

  env.ts reads the environment at import time, so the flags come first.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.MAIL_DOMAIN = 'mail.neiliro.test';
process.env.MAILGUN_SIGNING_KEY = 'test-signing-key';

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');
const { env } = await import('../env.js');
const { MAX_MESSAGE_BYTES } = await import('../lib/mail.js');
const { today } = await import('../db/index.js');

const SIGNING_KEY = 'test-signing-key';
const INBOUND = '/api/mail/inbound/mime';
const SMITHS = 'smiths-m1n2';
const JONES = 'jones-m3n4';
const WEBHOOK_HOST = 'in.neiliro.test';

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  delete process.env.MAIL_DOMAIN;
  delete process.env.MAILGUN_SIGNING_KEY;
  tenants.shutdownHosted();
});

function letter(messageId: string, subject: string): string {
  return [
    `Message-ID: <${messageId}>`,
    'From: "Riverside School" <office@school.example>',
    `To: ${SMITHS}@mail.neiliro.test`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Swimming on Friday, bring a towel.',
    '',
  ].join('\r\n');
}

/** A delivery signed the way Mailgun signs one: HMAC over timestamp+token. */
function delivery(
  fields: Record<string, string>,
  opts: { timestamp?: number; signature?: string } = {},
): string {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const token = 'a'.repeat(50);
  const signature =
    opts.signature ??
    createHmac('sha256', SIGNING_KEY).update(timestamp + token).digest('hex');
  return new URLSearchParams({ timestamp, token, signature, ...fields }).toString();
}

let app: FastifyInstance;
let smithsCookie: string;
let jonesCookie: string;

async function post(payload: string) {
  return app.inject({
    method: 'POST',
    url: INBOUND,
    headers: { host: WEBHOOK_HOST, 'content-type': 'application/x-www-form-urlencoded' },
    payload,
  });
}

/** The Mail section as that family sees it. */
async function mailbox(slug: string, cookie: string) {
  const res = await app.inject({
    url: '/api/mail',
    headers: { host: `${slug}.neiliro.test`, cookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    messages: { subject: string; from_address: string }[];
    configured: boolean;
    source: string | null;
    address: string | null;
  };
}

beforeAll(async () => {
  tenants.initHosted();
  tenants.createFamily(SMITHS);
  tenants.createFamily(JONES);
  app = await buildApp();

  for (const [slug, name] of [[SMITHS, 'Sam'], [JONES, 'Dana']] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { host: `${slug}.neiliro.test` },
      payload: { accept_terms: true, name, email: `${name.toLowerCase()}@${slug}.test`, password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === 'hub_session');
    const value = `hub_session=${cookie?.value ?? ''}`;
    if (slug === SMITHS) smithsCookie = value;
    else jonesCookie = value;
  }
});

describe('inbound family mail', () => {
  it('delivers a signed letter to the addressed family, and only to it', async () => {
    const res = await post(
      delivery({
        recipient: `${SMITHS}@mail.neiliro.test`,
        sender: 'office@school.example',
        'body-mime': letter('swim-1@school.example', 'Swimming on Friday'),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, stored: true });

    const smiths = await mailbox(SMITHS, smithsCookie);
    expect(smiths.messages.map((m) => m.subject)).toEqual(['Swimming on Friday']);

    // The invariant a mail router must never break
    const jones = await mailbox(JONES, jonesCookie);
    expect(jones.messages).toEqual([]);
  });

  it('hands the family the address derived from its slug', async () => {
    const smiths = await mailbox(SMITHS, smithsCookie);
    expect(smiths.address).toBe(`${SMITHS}@mail.neiliro.test`);
    expect(smiths.source).toBe('service');
    // Configured without an account row: the service issued the address
    expect(smiths.configured).toBe(true);
  });

  it('ignores a re-delivery of the same letter', async () => {
    const same = delivery({
      recipient: `${SMITHS}@mail.neiliro.test`,
      'body-mime': letter('dup-1@school.example', 'Sports day'),
    });
    expect((await post(same)).json()).toEqual({ ok: true, stored: true });

    // Mailgun retried; Message-ID absorbs it
    const retry = await post(
      delivery({
        recipient: `${SMITHS}@mail.neiliro.test`,
        'body-mime': letter('dup-1@school.example', 'Sports day'),
      }),
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ok: true, stored: false });

    const smiths = await mailbox(SMITHS, smithsCookie);
    expect(smiths.messages.filter((m) => m.subject === 'Sports day')).toHaveLength(1);
  });

  it('refuses a badly signed delivery', async () => {
    const res = await post(
      delivery(
        {
          recipient: `${SMITHS}@mail.neiliro.test`,
          'body-mime': letter('forged-1@attacker.example', 'Forged'),
        },
        { signature: 'f'.repeat(64) },
      ),
    );
    expect(res.statusCode).toBe(406);

    const smiths = await mailbox(SMITHS, smithsCookie);
    expect(smiths.messages.map((m) => m.subject)).not.toContain('Forged');
  });

  it('refuses a delivery with no signature at all', async () => {
    const res = await post(
      new URLSearchParams({
        recipient: `${SMITHS}@mail.neiliro.test`,
        'body-mime': letter('bare-1@attacker.example', 'Unsigned'),
      }).toString(),
    );
    expect(res.statusCode).toBe(406);
  });

  it('refuses a stale signature', async () => {
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    const res = await post(
      delivery(
        {
          recipient: `${SMITHS}@mail.neiliro.test`,
          'body-mime': letter('old-1@school.example', 'Old news'),
        },
        { timestamp: twoDaysAgo },
      ),
    );
    expect(res.statusCode).toBe(406);
  });

  it('refuses letters for a family that does not exist, without retries', async () => {
    const res = await post(
      delivery({
        recipient: 'nobody-z9y8@mail.neiliro.test',
        'body-mime': letter('nowhere-1@school.example', 'Nowhere'),
      }),
    );
    // 406 and not 5xx: anything else buys eight hours of Mailgun retries
    expect(res.statusCode).toBe(406);
  });

  it('refuses letters for a suspended family, and does not touch its data', async () => {
    /*
      Suspension is an operator action written straight into the registry.
      The slug is deliberately one the app has never served: familyIdBySlug
      caches for 30 s, so a status flipped under a warm slug keeps answering
      in the old state — accepted, and the reason this starts cold.
    */
    const paused = tenants.createFamily('paused-m9n8');
    const registry = new Database(join(env.dataDir, 'registry.db'));
    registry.prepare("UPDATE families SET status = 'suspended' WHERE slug = ?").run('paused-m9n8');
    registry.close();

    const res = await post(
      delivery({
        recipient: 'paused-m9n8@mail.neiliro.test',
        'body-mime': letter('paused-1@school.example', 'While away'),
      }),
    );
    // 406, so the sender gets a bounce instead of eight hours of retries
    expect(res.statusCode).toBe(406);

    // Nothing was written into the suspended family's database
    const file = new Database(join(env.dataDir, 'families', paused.familyId, 'hub.db'), {
      readonly: true,
    });
    const { n } = file.prepare('SELECT count(*) AS n FROM mail_messages').get() as { n: number };
    file.close();
    expect(n).toBe(0);
  });

  it('files an attachment inside the addressed family, and nowhere else', async () => {
    // Attachments follow the tenant, not the process: they land in the
    // family's own directory (Tenant.attachmentsDir), so a letter for one
    // family must leave the other's storage empty.
    const pdf = Buffer.from('%PDF-1.4 report').toString('base64');
    const withAttachment = [
      'Message-ID: <report-1@school.example>',
      'From: office@school.example',
      `To: ${SMITHS}@mail.neiliro.test`,
      'Subject: Term report',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Report attached.',
      '--B',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="term.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdf,
      '--B--',
      '',
    ].join('\r\n');

    const res = await post(
      delivery({ recipient: `${SMITHS}@mail.neiliro.test`, 'body-mime': withAttachment }),
    );
    expect(res.statusCode).toBe(200);

    const idOf = (slug: string) => {
      const registry = new Database(join(env.dataDir, 'registry.db'), { readonly: true });
      const row = registry.prepare('SELECT id FROM families WHERE slug = ?').get(slug) as { id: string };
      registry.close();
      return row.id;
    };
    const files = (slug: string) => {
      const dir = join(env.dataDir, 'families', idOf(slug), 'attachments');
      return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
    };

    expect(files(SMITHS).length).toBeGreaterThan(0);
    expect(files(JONES)).toEqual([]);
  });

  it('refuses letters addressed to another domain', async () => {
    const res = await post(
      delivery({
        recipient: `${SMITHS}@mail.elsewhere.test`,
        'body-mime': letter('elsewhere-1@school.example', 'Elsewhere'),
      }),
    );
    expect(res.statusCode).toBe(406);
  });

  it('refuses a delivery with no raw MIME — the route URL must end in "mime"', async () => {
    const res = await post(
      delivery({
        recipient: `${SMITHS}@mail.neiliro.test`,
        sender: 'office@school.example',
        subject: 'Parsed instead of raw',
        'body-plain': 'Mailgun parsed this because the URL stopped ending in mime',
      }),
    );
    expect(res.statusCode).toBe(406);
  });

  it('accepts a letter larger than the default 1 MB body limit', async () => {
    // A scanned bill is the ordinary case, and percent-encoding inflates
    // it further. Fastify's default limit would reject this as a 413 —
    // which Mailgun then retries for eight hours.
    const scan = Buffer.alloc(1_500_000, 7).toString('base64');
    const withAttachment = [
      'Message-ID: <scan-1@power.example>',
      'From: billing@power.example',
      `To: ${SMITHS}@mail.neiliro.test`,
      'Subject: Your bill',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Invoice attached.',
      '--B',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="bill.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      scan,
      '--B--',
      '',
    ].join('\r\n');

    const res = await post(
      delivery({ recipient: `${SMITHS}@mail.neiliro.test`, 'body-mime': withAttachment }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, stored: true });

    const smiths = await mailbox(SMITHS, smithsCookie);
    expect(smiths.messages.map((m) => m.subject)).toContain('Your bill');
  });

  it('stores nothing and asks for a retry when the attachment store fails (#187)', async () => {
    /*
      Ingest used to commit the message row and then save attachments one
      by one. A failure in between left a half-stored letter that was
      "known" by Message-ID from then on and never repaired — and every
      failure was answered 406, which told Mailgun to give up on it.

      Its own family, so the half-stored / retried state cannot disturb a
      sibling test's mailbox. The failure is real, not mocked: a regular
      file where the month folder has to be created makes the attachment
      write fail with EEXIST.
    */
    const FRAGILE = 'fragile-m5n6';
    tenants.createFamily(FRAGILE);
    const registry = new Database(join(env.dataDir, 'registry.db'), { readonly: true });
    const fragileId = (registry.prepare('SELECT id FROM families WHERE slug = ?').get(FRAGILE) as { id: string }).id;
    registry.close();
    const monthDir = join(env.dataDir, 'families', fragileId, 'attachments', today().slice(0, 7));
    mkdirSync(join(env.dataDir, 'families', fragileId, 'attachments'), { recursive: true });
    writeFileSync(monthDir, 'not a directory');

    const withAttachment = [
      'Message-ID: <fragile-1@school.example>',
      'From: office@school.example',
      `To: ${FRAGILE}@mail.neiliro.test`,
      'Subject: Permission slip',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Please sign.',
      '--B',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="slip.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 slip').toString('base64'),
      '--B--',
      '',
    ].join('\r\n');
    const send = () =>
      post(delivery({ recipient: `${FRAGILE}@mail.neiliro.test`, 'body-mime': withAttachment }));

    try {
      const failed = await send();
      // Retryable, not permanent
      expect(failed.statusCode).toBe(500);
      // And genuinely nothing was kept: no half-stored letter
      const fragileDb = new Database(join(env.dataDir, 'families', fragileId, 'hub.db'), { readonly: true });
      const rows = fragileDb.prepare("SELECT id FROM mail_messages WHERE subject = 'Permission slip'").all();
      const files = fragileDb.prepare('SELECT id FROM attachments').all();
      fragileDb.close();
      expect(rows).toEqual([]);
      expect(files).toEqual([]);
    } finally {
      rmSync(monthDir, { force: true });
    }

    // The retry Mailgun would make now succeeds, with the attachment
    const retried = await send();
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ ok: true, stored: true });
    const fragileDb = new Database(join(env.dataDir, 'families', fragileId, 'hub.db'), { readonly: true });
    const stored = fragileDb
      .prepare(
        `SELECT (SELECT count(*) FROM attachments a WHERE a.mail_message_id = m.id) AS n
           FROM mail_messages m WHERE m.subject = 'Permission slip'`,
      )
      .get() as { n: number } | undefined;
    fragileDb.close();
    expect(stored?.n).toBe(1);
  });

  it('refuses an oversized letter for good, before parsing it (#189)', { timeout: 30_000 }, async () => {
    // Over the raw-MIME cap: permanent, since a retry will not shrink it,
    // and rejected on a length check rather than a run of postal-mime.
    const huge = 'a'.repeat(MAX_MESSAGE_BYTES + 1);
    const started = Date.now();
    const res = await post(delivery({ recipient: `${SMITHS}@mail.neiliro.test`, 'body-mime': huge }));
    expect(res.statusCode).toBe(406);
    // Generous, but a parse of 25 MB of nothing would take far longer
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('routes a "+tag" address to the family that owns the local part', async () => {
    const res = await post(
      delivery({
        recipient: `${JONES}+bills@mail.neiliro.test`,
        'body-mime': letter('tagged-1@power.example', 'Electricity bill'),
      }),
    );
    expect(res.statusCode).toBe(200);

    const jones = await mailbox(JONES, jonesCookie);
    expect(jones.messages.map((m) => m.subject)).toEqual(['Electricity bill']);
  });
});

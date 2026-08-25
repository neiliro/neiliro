import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { runWithTenant } from '../db/index.js';
import { env } from '../env.js';
import { ingestEmail } from '../lib/mail.js';
import { log } from '../lib/log.js';
import { tenantForSlug } from '../lib/tenants.js';

/*
  Inbound family mail (#30, milestone C).

  Mailgun receives everything addressed to <slug>@<MAIL_DOMAIN> through a
  catch-all route and forwards it here. This is the second source feeding
  ingestEmail(), the first being the IMAP poller — the function itself
  stays source-agnostic, so everything downstream is unchanged.

  Two Mailgun details shape this file:

  1. The forward URL must END IN "mime", otherwise Mailgun sends its own
     parsed fields (body-plain, body-html) and omits body-mime — and this
     hub wants the raw MIME, which it already knows how to parse. Hence
     the path below; renaming it breaks ingestion in a way that looks like
     an empty body.

  2. The signature covers `timestamp + token` only — NOT the body. So a
     valid triplet lifted from a log could in principle be replayed with a
     different body. Two things bound that: the freshness window here, and
     ingest being idempotent by Message-ID, which turns a replay of a real
     letter into a no-op.
*/

/** The path Mailgun forwards to. Must end in "mime" — see above. */
const INBOUND_PATH = '/api/mail/inbound/mime';

/*
  A letter arrives percent-encoded inside a form field, which inflates it
  well past the raw MIME cap ingestEmail enforces. Fastify's default body
  limit is 1 MB — far too small for a scan of a utility bill, and it would
  fail as a 413 that Mailgun retries for eight hours.
*/
const MAX_INBOUND_BYTES = 40 * 1024 * 1024;

/*
  How old a signature may be. Generous on purpose: Mailgun retries a
  failed delivery for up to eight hours, and a window shorter than that
  would reject the retries of a letter that failed for an unrelated
  reason — losing real mail to defend against a threat that already
  requires reading our logs.
*/
const MAX_SIGNATURE_AGE_MS = 24 * 60 * 60 * 1000;

function signatureValid(timestamp: string, token: string, signature: string): boolean {
  const expected = createHmac('sha256', env.mailgunSigningKey)
    .update(timestamp + token)
    .digest();
  // A malformed hex string yields a short buffer, and timingSafeEqual
  // throws on a length mismatch — compare lengths first.
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The family a delivery belongs to. Only the local part is trusted as a
 * slug, and only when the domain is ours: a route misconfigured to
 * forward someone else's traffic must not reach a family database.
 */
function slugFromRecipient(recipient: string): string | null {
  const at = recipient.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = recipient.slice(at + 1).toLowerCase().trim();
  if (domain !== env.mailDomain) return null;
  // A "+tag" suffix is addressing sugar, not part of the family name
  const local = recipient.slice(0, at).toLowerCase().trim().split('+')[0] ?? '';
  return /^[a-z0-9-]{3,30}$/.test(local) ? local : null;
}

export async function registerInboundMailRoutes(app: FastifyInstance): Promise<void> {
  // Unconfigured means absent, not "present but refusing": a self-hosted
  // install has no business exposing this path at all.
  if (!env.mailDomain) return;

  /*
    Mailgun posts application/x-www-form-urlencoded. The API is otherwise
    JSON-only, so the parser exists for this route alone — URLSearchParams
    covers it without another dependency.
  */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: MAX_INBOUND_BYTES },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  /*
    Response codes are a protocol here, not decoration: Mailgun retries
    for eight hours on anything that is not 200 or 406. Every permanent
    rejection below must therefore be 406 — a 500 on an unknown family
    would turn one stray letter into hours of retries.
  */
  app.post(INBOUND_PATH, { bodyLimit: MAX_INBOUND_BYTES }, async (req, reply) => {
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    const { timestamp, token, signature } = form;

    if (!timestamp || !token || !signature || !signatureValid(timestamp, token, signature)) {
      log.warn('mail inbound: rejected an unsigned or badly signed delivery');
      return reply.code(406).send({ error: 'Bad signature' });
    }
    const age = Date.now() - Number(timestamp) * 1000;
    if (!Number.isFinite(age) || age > MAX_SIGNATURE_AGE_MS || age < -5 * 60_000) {
      log.warn('mail inbound: rejected a delivery with a stale signature');
      return reply.code(406).send({ error: 'Stale signature' });
    }

    const slug = slugFromRecipient(form.recipient ?? '');
    if (!slug) return reply.code(406).send({ error: 'Not a family address' });

    const tenant = tenantForSlug(slug);
    if (!tenant) {
      // No such family — or a suspended one. Permanent by design: the
      // sender gets a bounce from Mailgun instead of silence.
      log.warn(`mail inbound: no active family for "${slug}"`);
      return reply.code(406).send({ error: 'Unknown recipient' });
    }

    const mime = form['body-mime'];
    if (!mime) {
      // The route is forwarding parsed fields, which means its URL no
      // longer ends in "mime". Worth shouting about: mail would look
      // accepted and vanish.
      log.error('mail inbound: no body-mime — the Mailgun route URL must end in "mime"');
      return reply.code(406).send({ error: 'Raw MIME expected' });
    }

    try {
      const rowId = await runWithTenant(tenant, () => ingestEmail(mime));
      // The slug is logged, the letter is not: routing is operational
      // data, content is the family's.
      log.info(`mail inbound: ${rowId === null ? 'duplicate' : 'stored'} for "${slug}"`);
      return { ok: true, stored: rowId !== null };
    } catch (err) {
      // Unparseable MIME is permanent — retrying it changes nothing.
      log.error(`mail inbound: ingest failed for "${slug}"`, err);
      return reply.code(406).send({ error: 'Could not parse the message' });
    }
  });
}

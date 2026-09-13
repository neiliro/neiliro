import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, runWithTenant } from '../db/index.js';
import { env } from '../env.js';
import { issueFounderInvite } from '../lib/founder.js';
import { serviceMailAvailable } from '../lib/mail.js';
import { log } from '../lib/log.js';
import { defaultSlug } from '../lib/slug.js';
import {
  createFamily,
  pendingFamilyByFounderEmail,
  recordFounderEmail,
  tenantForFamily,
} from '../lib/tenants.js';

/*
  Self-serve sign-up (#262): the landing page creates the family.

  The form on the marketing site posts to a Pages Function on the apex,
  which forwards here with a bearer token the two sides share through
  env. The route answers only on the reserved host signup.<apex> — the
  same shape as the mail webhook on in.<apex> (#246) — and only in hosted
  mode: a self-hosted hub has one family and no landing page.

  What it does is what the operator's script did: derive the slug from
  the name, createFamily, issueFounderInvite. The letter is the only
  place the family's address appears. The reply never carries the slug
  or the URL, and is the same whether a family was created, an
  invitation re-issued, or nothing happened at all — the mailbox is the
  proof of ownership, exactly as with an operator-created family, and
  the address is never confirmed or denied to whoever typed it.

  A second sign-up with the same address while the first family is still
  unclaimed re-issues that family's invitation (the retire-and-replace in
  issueFounderInvite) instead of minting another family. Once the family
  has an administrator the address is free again: a person may run two
  families.

  Every accepted request sends one letter through the mail provider, so
  a flood is a deliverability problem before it is a disk problem. Besides
  the per-IP limit there is a process-wide hourly fuse; when it trips the
  route answers 503 honestly — a human retries in an hour, and a bot
  learns nothing it could not learn from the 429.
*/

const SLUG_ATTEMPTS = 3;

const bodySchema = z.object({
  family_name: z.string().trim().min(1, 'The family needs a name').max(80, 'That name is too long'),
  email: z.string().trim().toLowerCase().email('That is not an email address').max(120),
});

// Fixed one-hour window, reset when it ends. Good enough for a fuse: the
// point is a ceiling on letters per hour, not a fair scheduler.
let windowStart = 0;
let windowCount = 0;
function fuseTripped(): boolean {
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== windowStart) {
    windowStart = hour;
    windowCount = 0;
  }
  windowCount += 1;
  return windowCount > env.signupHourlyCap;
}

function bearerOk(header: string | undefined): boolean {
  const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(env.signupToken);
  return given.length === want.length && timingSafeEqual(given, want);
}

function familyHasUsers(familyId: string): boolean {
  return runWithTenant(tenantForFamily(familyId), () => {
    const { n } = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
    return n > 0;
  });
}

export async function registerSignupRoutes(app: FastifyInstance): Promise<void> {
  // No token, no route: an unauthenticated family-creation endpoint must
  // not exist by accident on an install that never configured sign-up.
  if (!env.hostedMode || !env.signupToken) return;
  const signupHost = `signup.${env.hostedDomain}`;
  const strictRate = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/signup', strictRate, async (req, reply) => {
    const host = (req.headers.host ?? '').split(':')[0]!.toLowerCase();
    // On any other host the route does not exist — a family's subdomain
    // has no use for it, and 404 is what an unknown path says there
    if (host !== signupHost) return reply.code(404).send({ error: 'Not found' });
    if (!bearerOk(req.headers.authorization)) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    if (!serviceMailAvailable()) {
      log.error('signup: service mail is not configured — the invitation could not be sent');
      return reply.code(503).send({ error: 'Sign-up is not available right now' });
    }
    if (fuseTripped()) {
      log.warn(`signup: hourly cap of ${env.signupHourlyCap} reached — refusing until the hour turns`);
      return reply.code(503).send({ error: 'Sign-up is busy right now, please try again in an hour' });
    }

    const { family_name: name, email } = parsed.data;
    const pending = pendingFamilyByFounderEmail(email);
    let familyId = pending && !familyHasUsers(pending) ? pending : null;

    if (!familyId) {
      // The suffix makes a collision a one-in-1.6-million event; three
      // draws make it a non-event without a loop that could spin
      for (let attempt = 1; attempt <= SLUG_ATTEMPTS && !familyId; attempt += 1) {
        const slug = defaultSlug(name);
        try {
          familyId = createFamily(slug).familyId;
        } catch (err) {
          if (attempt === SLUG_ATTEMPTS || !/already taken/.test((err as Error).message)) throw err;
        }
      }
      recordFounderEmail(familyId!, email);
    }

    await issueFounderInvite(familyId!, email);
    log.notice(`signup: ${pending && pending === familyId ? 're-issued invitation for' : 'created'} family ${familyId} (${name.length} chars in the name)`);
    return reply.code(202).send({ ok: true });
  });
}

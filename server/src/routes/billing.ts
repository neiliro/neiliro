import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { env } from '../env.js';
import { log } from '../lib/log.js';
import { planRow, recordBillingEvent, recordSubscription } from '../lib/tenants.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The JSON body as sent — the webhook signature covers these bytes. */
    rawBody?: string;
  }
}

/*
  Paddle tells us what happened (#265). Paddle is the merchant of record:
  it sells the subscription, holds the card, issues the receipt, retries a
  failed payment and refunds. What reaches us is a stream of signed events
  on the reserved host billing.<apex>, and the only thing we keep from them
  is the subscription's current shape in the registry — lib/plan.ts turns
  that into "writable or read-only".

  Three rules keep this honest:
  - The signature (HMAC-SHA256 over `ts:rawBody` with the destination's
    secret, hex, in the Paddle-Signature header) is checked on the bytes
    as sent. A stale timestamp is refused too: a captured event must not
    be replayable a week later.
  - Every event id is written down before anything moves. Paddle retries
    whatever did not answer 200, so a replay is answered 200 and ignored.
  - The family comes from custom_data.family_id, set at checkout by the
    page on the apex and copied by Paddle onto the subscription. Never
    the slug: a family renames itself once, and an event about the old
    name must still land.

  Only subscription.* events change anything. Transactions are receipts;
  the subscription's status already says what a completed or failed
  payment meant for the family.
*/

const TOLERANCE_MS = 5 * 60_000;

interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: {
    id: string;
    status?: string;
    customer_id?: string;
    custom_data?: { family_id?: string } | null;
    current_billing_period?: { starts_at: string; ends_at: string } | null;
    next_billed_at?: string | null;
    canceled_at?: string | null;
  };
}

export function signatureValid(header: string | undefined, rawBody: string, secret: string, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = new Map(header.split(';').map((kv) => kv.split('=') as [string, string]));
  const ts = Number(parts.get('ts'));
  const h1 = parts.get('h1') ?? '';
  if (!Number.isFinite(ts) || !h1) return false;
  if (Math.abs(nowMs - ts * 1000) > TOLERANCE_MS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(h1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SQLite's stamp for the registry, from Paddle's ISO. */
const stamp = (iso: string | null | undefined): string | null =>
  iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : null;

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  if (!env.hostedMode || !env.paddleWebhookSecret) return;
  const billingHost = `billing.${env.hostedDomain}`;

  app.post('/api/billing/paddle', async (req, reply) => {
    const host = (req.headers.host ?? '').split(':')[0]!.toLowerCase();
    if (host !== billingHost) return reply.code(404).send({ error: 'Not found' });
    const signature = req.headers['paddle-signature'];
    if (!signatureValid(typeof signature === 'string' ? signature : undefined, req.rawBody ?? '', env.paddleWebhookSecret)) {
      log.warn('billing: rejected an unsigned or badly signed Paddle event');
      return reply.code(401).send({ error: 'Bad signature' });
    }

    const event = req.body as PaddleEvent;
    if (!event?.event_id || !event.event_type) return reply.code(400).send({ error: 'Not a Paddle event' });
    const familyId = event.data?.custom_data?.family_id ?? null;

    if (!recordBillingEvent(event.event_id, event.event_type, familyId)) {
      return reply.code(200).send({ ok: true, replay: true });
    }
    if (!event.event_type.startsWith('subscription.')) return reply.code(200).send({ ok: true });

    // A subscription that names no family, or a family that is gone, is
    // answered 200 all the same: refusing would only make Paddle retry a
    // fact we cannot place. The log line is for the operator.
    if (!familyId || !planRow(familyId)) {
      log.warn(`billing: ${event.event_type} ${event.data.id} names no live family (${familyId ?? 'no custom_data'})`);
      return reply.code(200).send({ ok: true });
    }
    const { data } = event;
    // On cancellation Paddle may drop the billing period; the paid time
    // already recorded is honoured, and the plan ends when the period does
    const periodEnd =
      data.status === 'canceled' && !data.current_billing_period
        ? stamp(data.canceled_at ?? event.occurred_at)
        : stamp(data.current_billing_period?.ends_at ?? data.next_billed_at);
    recordSubscription(familyId, {
      customerId: data.customer_id ?? '',
      subscriptionId: data.id,
      status: data.status ?? 'active',
      periodEnd,
    });
    log.notice(`billing: family ${familyId} subscription ${data.id} is ${data.status} (${event.event_type})`);
    return reply.code(200).send({ ok: true });
  });
}

/** A customer-portal link, minted on demand — Paddle's tokens are short-lived and must not be cached. */
export async function customerPortalUrl(customerId: string): Promise<string | null> {
  if (!env.paddleApiKey) return null;
  const base = env.paddleEnv === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
  const res = await fetch(`${base}/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.paddleApiKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    log.warn(`billing: portal session for ${customerId} refused with ${res.status}`);
    return null;
  }
  const body = (await res.json()) as { data?: { urls?: { general?: { overview?: string } } } };
  return body.data?.urls?.general?.overview ?? null;
}

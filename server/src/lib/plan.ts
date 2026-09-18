/*
  What a family may do, derived from what the registry knows (#265).

  The registry stores facts — when the family was created, whether it was
  grandfathered, what Paddle last said about its subscription — and this
  module turns them into one answer for the rest of the code: writable or
  read-only, until when, and what happens next. Deriving rather than
  storing the state is the same rule as balances in money: a stored
  "read_only" flag would go stale the moment a payment arrives while the
  process is down.

  The terms (2026-09-13) in code form:
    - 30 days free from creation, no card — `trial`
    - a paid subscription: writable while Paddle says active; a failed
      payment leaves 14 days of grace before read-only; a cancellation
      runs to the end of the paid period
    - families created before the launch keep the promise made to them:
      `legacy_free` until a date the operator sets
    - read-only is sign in, read, export — for 60 days; then removal
*/

export const TRIAL_DAYS = 30;
export const GRACE_DAYS = 14;
export const READ_ONLY_DAYS = 60;
const DAY_MS = 24 * 60 * 60_000;

/** The registry's billing facts for one family. */
export interface PlanRow {
  created_at: string;
  /** 'trial' | 'paid' | 'legacy_free' — NULL reads as 'trial' */
  plan: string | null;
  /** Trial end, legacy end, or the paid period's end — depends on `plan` */
  plan_until: string | null;
  /** Paddle's own word: active | trialing | past_due | paused | canceled */
  subscription_status: string | null;
  paddle_customer_id: string | null;
  paddle_subscription_id: string | null;
  /** Free days earned through referrals (#336) — added to a free period, never to a paid one. */
  bonus_days?: number | null;
}

export type PlanState = 'trial' | 'active' | 'grace' | 'canceling' | 'legacy_free' | 'read_only';

export interface Entitlement {
  state: PlanState;
  /** True when writes must be refused. */
  readOnly: boolean;
  /** When the current writable state ends, or when read-only began. */
  until: string | null;
  /** When the family's data is removed, once read-only (ISO). */
  deleteAt: string | null;
  /** Whether a Paddle subscription exists to manage. */
  subscribed: boolean;
  /**
   * Referral days counted into `until` above (#336). Zero for most
   * families; on a paid plan the days are owed but not yet spendable —
   * see the note in entitlement().
   */
  bonusDays: number;
}

/** SQLite's 'YYYY-MM-DD HH:MM:SS' (UTC) or an ISO string → epoch ms. */
export function toMs(stamp: string): number {
  return new Date(stamp.includes('T') ? stamp : stamp.replace(' ', 'T') + 'Z').getTime();
}
const iso = (ms: number): string => new Date(ms).toISOString();

export function entitlement(row: PlanRow, nowMs = Date.now()): Entitlement {
  const plan = row.plan ?? 'trial';
  /*
    Referral days (#336) lengthen a FREE period — a trial or a
    grandfathered one — and nothing else. On a paid plan the family is
    not waiting for a date we control: the next charge is Paddle's, and
    shortening it means a credit there, not arithmetic here. The days
    stay on the row, visible in the card, and the operator settles them
    with the provider; lib/referral-debt.ts would be the automation, and
    it does not exist while no paying family has earned one.
  */
  const bonus = Math.max(0, row.bonus_days ?? 0) * DAY_MS;
  const readOnlyFrom = (sinceMs: number): Entitlement => ({
    state: 'read_only',
    readOnly: true,
    until: iso(sinceMs),
    deleteAt: iso(sinceMs + READ_ONLY_DAYS * DAY_MS),
    subscribed: Boolean(row.paddle_subscription_id),
    bonusDays: Math.max(0, row.bonus_days ?? 0),
  });
  const owed = Math.max(0, row.bonus_days ?? 0);

  if (plan === 'paid' && row.paddle_subscription_id) {
    const periodEnd = row.plan_until ? toMs(row.plan_until) : null;
    const status = row.subscription_status ?? 'active';
    if (status === 'active' || status === 'trialing') {
      return { state: 'active', readOnly: false, until: periodEnd ? iso(periodEnd) : null, deleteAt: null, subscribed: true, bonusDays: owed };
    }
    if (status === 'past_due') {
      // Paddle retries the payment for a while; the family keeps writing
      // through the grace window measured from the period that was not paid
      const graceEnd = (periodEnd ?? nowMs) + GRACE_DAYS * DAY_MS;
      if (nowMs < graceEnd) return { state: 'grace', readOnly: false, until: iso(graceEnd), deleteAt: null, subscribed: true, bonusDays: owed };
      return readOnlyFrom(graceEnd);
    }
    // canceled or paused: the paid period is honoured, then read-only
    if (periodEnd && nowMs < periodEnd) {
      return { state: 'canceling', readOnly: false, until: iso(periodEnd), deleteAt: null, subscribed: true, bonusDays: owed };
    }
    return readOnlyFrom(periodEnd ?? nowMs);
  }

  if (plan === 'legacy_free') {
    const until = row.plan_until ? toMs(row.plan_until) + bonus : null;
    if (!until || nowMs < until) {
      return { state: 'legacy_free', readOnly: false, until: until ? iso(until) : null, deleteAt: null, subscribed: false, bonusDays: owed };
    }
    return readOnlyFrom(until);
  }

  // trial — from creation plus whatever referrals added, whatever
  // plan_until says (it is derived, not set)
  const trialEnd = toMs(row.created_at) + TRIAL_DAYS * DAY_MS + bonus;
  if (nowMs < trialEnd) return { state: 'trial', readOnly: false, until: iso(trialEnd), deleteAt: null, subscribed: false, bonusDays: owed };
  return readOnlyFrom(trialEnd);
}

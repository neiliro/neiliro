import { describe, expect, it } from 'vitest';
import { entitlement, GRACE_DAYS, READ_ONLY_DAYS, TRIAL_DAYS, type PlanRow } from './plan.js';

const DAY = 24 * 60 * 60_000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  created_at: stamp(T0),
  plan: null,
  plan_until: null,
  subscription_status: null,
  paddle_customer_id: null,
  paddle_subscription_id: null,
  ...over,
});

describe('entitlement', () => {
  it('a new family is on trial for 30 days from creation, then read-only, then gone after 60 more', () => {
    const fresh = entitlement(row(), T0 + DAY);
    expect(fresh.state).toBe('trial');
    expect(fresh.readOnly).toBe(false);
    expect(fresh.until).toBe(new Date(T0 + TRIAL_DAYS * DAY).toISOString());

    const lapsed = entitlement(row(), T0 + (TRIAL_DAYS + 1) * DAY);
    expect(lapsed.state).toBe('read_only');
    expect(lapsed.readOnly).toBe(true);
    expect(lapsed.deleteAt).toBe(new Date(T0 + (TRIAL_DAYS + READ_ONLY_DAYS) * DAY).toISOString());
  });

  it('a paid family writes while Paddle says active, whatever the trial clock says', () => {
    const paid = row({ plan: 'paid', paddle_subscription_id: 'sub_1', subscription_status: 'active', plan_until: stamp(T0 + 400 * DAY) });
    const e = entitlement(paid, T0 + 200 * DAY);
    expect(e.state).toBe('active');
    expect(e.readOnly).toBe(false);
    expect(e.subscribed).toBe(true);
  });

  it('a failed payment leaves 14 days of grace after the unpaid period, then read-only', () => {
    const periodEnd = T0 + 30 * DAY;
    const pastDue = row({ plan: 'paid', paddle_subscription_id: 'sub_1', subscription_status: 'past_due', plan_until: stamp(periodEnd) });
    expect(entitlement(pastDue, periodEnd + 3 * DAY).state).toBe('grace');
    const after = entitlement(pastDue, periodEnd + (GRACE_DAYS + 1) * DAY);
    expect(after.state).toBe('read_only');
    expect(after.until).toBe(new Date(periodEnd + GRACE_DAYS * DAY).toISOString());
  });

  it('a cancellation runs to the end of the paid period', () => {
    const periodEnd = T0 + 30 * DAY;
    const canceled = row({ plan: 'paid', paddle_subscription_id: 'sub_1', subscription_status: 'canceled', plan_until: stamp(periodEnd) });
    expect(entitlement(canceled, periodEnd - DAY).state).toBe('canceling');
    expect(entitlement(canceled, periodEnd - DAY).readOnly).toBe(false);
    expect(entitlement(canceled, periodEnd + DAY).state).toBe('read_only');
  });

  it('a grandfathered family is free until the date the operator set, and forever without one', () => {
    const until = T0 + 365 * DAY;
    const legacy = row({ plan: 'legacy_free', plan_until: stamp(until) });
    expect(entitlement(legacy, T0 + 300 * DAY).state).toBe('legacy_free');
    expect(entitlement(legacy, until + DAY).state).toBe('read_only');
    expect(entitlement(row({ plan: 'legacy_free' }), T0 + 5000 * DAY).state).toBe('legacy_free');
  });

  it('reads SQLite stamps as UTC, like now() writes them', () => {
    const e = entitlement(row({ created_at: '2026-10-01 12:00:00' }), T0 + DAY);
    expect(e.until).toBe(new Date(T0 + TRIAL_DAYS * DAY).toISOString());
  });
});

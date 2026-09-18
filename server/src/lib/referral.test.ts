import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entitlement, TRIAL_DAYS, type PlanRow } from './plan.js';

/*
  Referrals (#336): a family invites another, both gain a free month —
  the invited one immediately, the inviter only when the invited family
  has actually paid.

  env is read at import time, hence the flags before the dynamic imports.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';

const tenants = await import('./tenants.js');

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  tenants.shutdownHosted();
});

const DAY = 24 * 60 * 60_000;

describe('a referral code', () => {
  let inviter: string;

  beforeAll(() => {
    tenants.initHosted();
    inviter = tenants.createFamily('inviters-fam').familyId;
  });

  it('is minted once and stays: a link already shared must keep working', () => {
    const first = tenants.referralCode(inviter);
    expect(first).toMatch(/^[a-z2-9]{8}$/);
    expect(tenants.referralCode(inviter)).toBe(first);
  });

  it('never spells the family address — that is what the ghost protects', () => {
    const code = tenants.referralCode(inviter);
    expect(code).not.toContain('inviters');
    expect(tenants.familyByReferralCode(code)).toBe(inviter);
    expect(tenants.familyByReferralCode('zzzzzzzz')).toBeNull();
  });

  it('stops working when the family is gone, so a stale link pays nobody', () => {
    const leaver = tenants.createFamily('leavers-fam').familyId;
    const code = tenants.referralCode(leaver);
    expect(tenants.familyByReferralCode(code)).toBe(leaver);
    tenants.deleteFamilyData(leaver);
    expect(tenants.familyByReferralCode(code)).toBeNull();
  });
});

describe('what each side gets', () => {
  let inviter: string;
  let invited: string;

  beforeAll(() => {
    tenants.initHosted();
    inviter = tenants.createFamily('hosts-fam').familyId;
    invited = tenants.createFamily('guests-fam').familyId;
    tenants.recordReferral(invited, inviter);
  });

  it('gives the invited family its month up front', () => {
    const row = tenants.planRow(invited)!;
    expect(row.bonus_days).toBe(tenants.REFERRAL_BONUS_DAYS);
    const free = entitlement(row);
    const expected = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime() + (TRIAL_DAYS + 30) * DAY;
    expect(free.state).toBe('trial');
    expect(Date.parse(free.until!)).toBe(expected);
    expect(free.bonusDays).toBe(30);
  });

  it('gives the inviter nothing until the invited family pays', () => {
    expect(tenants.planRow(inviter)!.bonus_days).toBe(0);
    expect(tenants.referralStats(inviter)).toEqual({ joined: 1, subscribed: 0, bonusDays: 0 });
  });

  it('pays the inviter on that first payment, and exactly once', () => {
    expect(tenants.rewardReferrer(invited)).toBe(inviter);
    expect(tenants.planRow(inviter)!.bonus_days).toBe(30);
    // Paddle retries, and a family may resubscribe years later: neither pays again
    expect(tenants.rewardReferrer(invited)).toBeNull();
    expect(tenants.rewardReferrer(invited)).toBeNull();
    expect(tenants.planRow(inviter)!.bonus_days).toBe(30);
    expect(tenants.referralStats(inviter)).toEqual({ joined: 1, subscribed: 1, bonusDays: 30 });
  });

  it('tells the inviter counts and nothing about who joined', () => {
    const stats = tenants.referralStats(inviter);
    expect(Object.keys(stats).sort()).toEqual(['bonusDays', 'joined', 'subscribed']);
  });
});

describe('the days themselves', () => {
  const base: PlanRow = {
    created_at: '2026-01-01 00:00:00',
    plan: null,
    plan_until: null,
    subscription_status: null,
    paddle_customer_id: null,
    paddle_subscription_id: null,
    bonus_days: 30,
  };
  const at = (iso: string) => Date.parse(iso);

  it('lengthen a trial', () => {
    const e = entitlement(base, at('2026-01-31T12:00:00Z'));
    expect(e.state).toBe('trial'); // day 30 — plain trial would be over
    expect(e.until).toBe('2026-03-02T00:00:00.000Z');
  });

  it('lengthen a grandfathered free period too', () => {
    const e = entitlement({ ...base, plan: 'legacy_free', plan_until: '2026-06-01 00:00:00' }, at('2026-06-15T00:00:00Z'));
    expect(e.state).toBe('legacy_free');
    expect(e.until).toBe('2026-07-01T00:00:00.000Z');
  });

  it('are owed but not spent on a paid plan — the next charge is the provider’s', () => {
    const e = entitlement(
      { ...base, plan: 'paid', paddle_subscription_id: 'sub_1', subscription_status: 'active', plan_until: '2026-02-01 00:00:00' },
      at('2026-01-15T00:00:00Z'),
    );
    expect(e.state).toBe('active');
    expect(e.until).toBe('2026-02-01T00:00:00.000Z'); // untouched by the bonus
    expect(e.bonusDays).toBe(30);
  });

  it('change nothing for a family that never referred anyone', () => {
    const e = entitlement({ ...base, bonus_days: 0 }, at('2026-01-15T00:00:00Z'));
    expect(e.until).toBe('2026-01-31T00:00:00.000Z');
    expect(e.bonusDays).toBe(0);
  });
});

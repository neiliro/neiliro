import { db, now, runWithTenant } from '../db/index.js';
import { FOUNDER_INVITE_TTL_MS } from './founder.js';
import { log } from './log.js';
import { deleteFamilyData, signupFamiliesCreatedBefore, tenantForFamily } from './tenants.js';

/*
  A family that signed itself up (#262) and never opened the letter is an
  empty hub.db with a retired slug's worth of namespace. A day after the
  founder's invitation could last have expired, a family that still has no
  user and no live invitation is removed the way self-deletion removes one.
  Only families created by sign-up are considered — the registry remembers
  the founder's address for exactly this — so an operator-created family
  waiting on a mistyped address is left for the operator to re-issue.

  The registry row stays, status 'deleted', as for every removed family:
  derived slugs carry a random suffix, so the retired names cost nothing.
*/

/*
  Derived, not chosen. The grace period says one thing — "a day after the
  last possible link died" — and the two numbers were independent until
  2026-09-15, when the invitation went from two days to seven and this one
  would have started reaping families whose links were still live. A
  constant that has to be remembered eventually is not.
*/
export const REAP_GRACE_MS = FOUNDER_INVITE_TTL_MS + 24 * 60 * 60_000;

export function reapUnclaimedFamilies(): number {
  const cutoff = new Date(Date.now() - REAP_GRACE_MS).toISOString().replace('T', ' ').slice(0, 19);
  let reaped = 0;
  for (const family of signupFamiliesCreatedBefore(cutoff)) {
    const unclaimed = runWithTenant(tenantForFamily(family.id), () => {
      const { users } = db.prepare('SELECT count(*) AS users FROM users').get() as { users: number };
      if (users > 0) return false;
      const live = db
        .prepare("SELECT 1 FROM invites WHERE role = 'admin' AND used_at IS NULL AND expires_at > ?")
        .get(now());
      return !live;
    });
    if (!unclaimed) continue;
    deleteFamilyData(family.id);
    reaped += 1;
  }
  if (reaped > 0) log.notice(`reaper: removed ${reaped} unclaimed sign-up ${reaped === 1 ? 'family' : 'families'}`);
  return reaped;
}

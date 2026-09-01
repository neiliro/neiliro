import { ISSUES_URL, SUPPORT_URL } from './build';

/** The apex the hosted service runs on. See supportLink below. */
const SERVICE_DOMAIN = 'neiliro.com';

/**
 * Where "I need help" leads, which is not the same answer for everyone.
 *
 * A self-hoster owns the machine: the fix is in the code, the answer helps
 * the next person with the same problem, and we cannot see their hub
 * anyway — so they go to GitHub issues.
 *
 * A family on the hosted service goes to the support site, which knows
 * their questions and can take a message.
 *
 * The hostname check is not belt-and-braces. Hosted mode ships in the
 * open-source repo and someone else can run a service of their own; a
 * "Support" link hardcoded to our address would quietly hand us their
 * families' messages. Whose service this is, only the address says.
 */
export function supportLink(
  hosted: boolean,
  hostname: string,
): { href: string; label: 'Support' | 'Report a bug' } {
  const ours = hostname === SERVICE_DOMAIN || hostname.endsWith(`.${SERVICE_DOMAIN}`);
  return hosted && ours
    ? { href: SUPPORT_URL, label: 'Support' }
    : { href: ISSUES_URL, label: 'Report a bug' };
}

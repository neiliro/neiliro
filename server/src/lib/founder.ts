import { randomBytes } from 'node:crypto';
import { db, id, now, runWithTenant } from '../db/index.js';
import { env } from '../env.js';
import { hashInviteToken, INVITE_TTL_MS } from '../routes/setup.js';
import { sendServiceEmail, serviceMailAvailable } from './mail.js';
import { log } from './log.js';
import { familySlug, tenantForFamily } from './tenants.js';

/*
  The founder invitation (#157): how a hosted family meets its hub.

  Provisioning used to end with a bare URL, and the first person to open
  it became the administrator. Two things were wrong with that once the
  link travels by mail rather than by hand. A leaked URL hands the family
  to whoever opens it — nothing binds the link to a person. And the
  administrator ends up with a login nobody proved, which is their one
  and only recovery channel: members get their password reset by the
  admin, the admin gets it by email, and admin-reset.mjs needs a shell a
  hosted family does not have.

  So the service takes the administrator's address at provisioning and
  mails the invitation there, as the ordinary single-use invite with role
  'admin'. While that invitation exists the open first-run screen is
  closed (routes/setup.ts), and the account created through it starts out
  with the address confirmed — receiving the link is the proof.
*/

export interface FounderInvite {
  url: string;
  /** Whether the invitation went out by mail, or has to be handed over. */
  mailed: boolean;
}

/**
 * Issue (or re-issue) the founder invitation for a family that has no
 * administrator yet, and mail it when the service can. Re-issuing retires
 * the earlier, unused invitation: the family holds one live link.
 *
 * When service mail is not configured the link is returned for the
 * operator to deliver — the door is still bound to a token, only the
 * address is not proven by construction, and confirmation is not a thing
 * on such a service anyway (routes/email-verify.ts).
 */
export async function issueFounderInvite(familyId: string, email: string): Promise<FounderInvite> {
  const slug = familySlug(familyId);
  if (!slug) throw new Error('No such family');
  const address = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error(`"${email}" is not an email address`);

  const token = randomBytes(24).toString('base64url');
  runWithTenant(tenantForFamily(familyId), () => {
    const { n } = db.prepare('SELECT count(*) AS n FROM users').get() as { n: number };
    if (n > 0) throw new Error('The family already has an administrator');
    db.transaction(() => {
      db.prepare("DELETE FROM invites WHERE role = 'admin' AND used_at IS NULL").run();
      db.prepare(
        `INSERT INTO invites (id, token_hash, role, created_by, email, created_at, expires_at)
         VALUES (?, ?, 'admin', NULL, ?, ?, ?)`,
      ).run(
        id(),
        hashInviteToken(token),
        address,
        now(),
        new Date(Date.now() + INVITE_TTL_MS).toISOString().replace('T', ' ').slice(0, 19),
      );
    })();
  });

  const url = `https://${slug}.${env.hostedDomain}/join?token=${token}`;
  if (!serviceMailAvailable()) {
    log.notice(`founder invitation issued for ${slug} (not mailed: service mail is off)`);
    return { url, mailed: false };
  }
  // The letter is the onboarding — there is no separate welcome document
  // (decided 2026-09-09). It says what the family should do first, what a
  // beta means, and repeats the one promise made to beta families, which
  // the terms of service state authoritatively: the letter must never say
  // more than /terms does. The beta paragraph is service policy, not
  // product behaviour — rewrite it at the public launch.
  const apex = env.hostedDomain;
  await sendServiceEmail(
    address,
    'Your Neiliro family is ready',
    [
      'Hello.',
      '',
      `Your family's hub is waiting at https://${slug}.${apex}/ — this link`,
      'sets up the first account, which becomes the administrator:',
      '',
      url,
      '',
      'It works once and for a week. Use this address as your login and it is',
      'already confirmed for password recovery; you can pick another, and',
      'we will ask you to confirm that one instead.',
      '',
      'First steps, in the order they pay off:',
      '',
      `  1. Choose the hub's address. Within the first day you can change`,
      `     ${slug}.${apex} once — the hub offers this when you sign in. After`,
      '     that it is final, so pick something you can say aloud.',
      '  2. Invite the household: Settings → Users → invitation link. Each',
      '     person joins with their own name and password; for a child without',
      '     a device, open their link yourself.',
      '  3. Put it on the phone: open the hub in the phone browser and choose',
      '     "Add to Home Screen". It keeps working read-only without a signal.',
      `  4. Your family mailbox is ${slug}@${env.mailDomain}. Send the school`,
      '     and the bills there — a letter becomes a task in one click.',
      '',
      'What the beta means. Neiliro is in closed beta: it runs with monitoring',
      'and nightly encrypted backups, but the honest word is best effort —',
      'something may break, and when it does we want to hear about it.',
      'Everything you put in stays yours: the complete archive is one click',
      'away in Settings, on any plan, always. Families who join during the',
      'beta get the paid plan free for a year from the public launch; that',
      `promise is written into the terms, not only this letter: https://${apex}/terms`,
      '',
      `Questions, or something broke: https://support.${apex} — the form there`,
      `reaches a person — or write to hello@${apex}.`,
    ].join('\n'),
  );
  log.notice(`founder invitation mailed for ${slug}`);
  return { url, mailed: true };
}

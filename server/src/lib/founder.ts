import { randomBytes } from 'node:crypto';
import { db, id, now, runWithTenant } from '../db/index.js';
import { env } from '../env.js';
import { hashInviteToken } from '../routes/setup.js';
import { sendServiceEmail, serviceMailAvailable } from './mail.js';
import { renderLetterHtml, renderLetterText, type Letter } from './letter.js';
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

/**
 * How long the founder's link lives — a member invitation's week
 * (routes/setup.ts).
 *
 * It was two days until 2026-09-15, set when families were handed out by
 * an operator who knew the address was live and the person was waiting.
 * Self-serve sign-up made the assumption false: somebody creates a family
 * from a phone on Friday evening and sits down at a computer on Monday,
 * which is ordinary behaviour, not neglect. The short window turned that
 * into a dead link, and then the reaper took the family — and nobody
 * writes to support about it, they just leave.
 *
 * The risk the two days guarded against is unchanged and small: the link
 * opens an EMPTY hub, and it was mailed to the one address that asked for
 * one. A week of exposure for a hub with nothing in it buys back the
 * people who read their mail on their own schedule.
 */
export const FOUNDER_INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

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
        new Date(Date.now() + FOUNDER_INVITE_TTL_MS).toISOString().replace('T', ' ').slice(0, 19),
      );
    })();
  });

  const url = `https://${slug}.${env.hostedDomain}/join?token=${token}`;
  if (!serviceMailAvailable()) {
    log.notice(`founder invitation issued for ${slug} (not mailed: service mail is off)`);
    return { url, mailed: false };
  }
  // The letter is the onboarding — there is no separate welcome document
  // (decided 2026-09-09). It says what the family should do first, what to
  // expect from a young service, and what it costs — in the words of the
  // terms of service, which state it authoritatively: the letter must never
  // say more than /terms does. Pricing (decided 2026-09-13): 30 days free
  // without a card, then €4.99 a month or €44.99 a year per family; until
  // payment exists in the app the trial simply continues.
  const apex = env.hostedDomain;
  const letter: Letter = {
    title: 'Your family is ready',
    brand: { name: 'Neiliro', url: `https://${apex}/` },
    blocks: [
      {
        kind: 'p',
        text: `Your family's hub is waiting at https://${slug}.${apex}/. The link below sets up the first account, which becomes the administrator.`,
      },
      { kind: 'button', label: 'Set up your family', url },
      {
        kind: 'muted',
        // The life is interpolated, not spelled out: the letter said "two
        // days" for the hour after the link started living a week (2.3.1),
        // which is the one sentence a reader acts on — somebody told the
        // link was dead does not try it.
        text: `It works once and for ${FOUNDER_INVITE_TTL_MS / 86_400_000} days; if it has expired, ask for the family again from the website and a fresh link arrives. Use this address as your login and it is already confirmed for password recovery; you can pick another, and we will ask you to confirm that one instead.`,
      },
      { kind: 'p', text: 'First steps, in the order they pay off:' },
      {
        kind: 'steps',
        items: [
          {
            title: "Choose the hub's address.",
            text: `Within the first day you can change ${slug}.${apex} once — the hub offers this when you sign in. After that it is final, so pick something you can say aloud.`,
          },
          {
            title: 'Keep the recovery code.',
            text: 'When you set up the first account, the hub shows a recovery code once. What your family writes is encrypted in the browser with a key we never hold — the code is the spare key. Without your password and without the code the words are gone for good, and nobody can bring them back, us included. Put it where you keep the passports.',
          },
          {
            title: 'Invite the household.',
            text: 'Settings → People → invitation link. Each person joins with their own name and password; for a child without a device, open their link yourself.',
          },
          {
            title: 'Put it on the phone.',
            text: 'Open the hub in the phone browser and choose "Add to Home Screen". It keeps working read-only without a signal.',
          },
          {
            title: 'Send the paperwork to your family mailbox.',
            text: `Your address is ${slug}@${env.mailDomain}. Send the school and the bills there — a letter becomes a task, an invitation an event, a bill a transaction, in one click each.`,
          },
        ],
      },
      {
        kind: 'p',
        text: 'What to expect. Neiliro is young: it runs with monitoring and nightly encrypted backups, but the honest word is best effort — something may break, and when it does we want to hear about it. Everything you put in stays yours: the complete archive and a readable copy are one click away in Settings, always.',
      },
      {
        kind: 'p',
        text: 'What it costs. The first 30 days are free, no card needed. After that one plan covers the whole family: €4.99 a month or €44.99 a year, cancel anytime. We write to you before the free period ends.',
      },
      { kind: 'link', text: 'The terms say the same, authoritatively:', url: `https://${apex}/terms` },
      {
        kind: 'link',
        text: `Questions, or something broke — the form there reaches a person, or write to hello@${apex}:`,
        url: `https://support.${apex}/`,
      },
    ],
    footer: `You received this letter because a Neiliro family was created with this address. It carries no images and no tracking; if you did not ask for a family, ignore it and the link expires on its own.`,
  };
  await sendServiceEmail(address, 'Your Neiliro family is ready', renderLetterText(letter), renderLetterHtml(letter));
  log.notice(`founder invitation mailed for ${slug}`);
  return { url, mailed: true };
}

import { db, runWithTenant } from '../db/index.js';
import { env } from '../env.js';
import { log } from './log.js';
import { sendServiceEmail, serviceMailAvailable } from './mail.js';
import { entitlement, type Entitlement } from './plan.js';
import { deleteFamilyData, familiesWithPlans, recordPlanLetter, tenantForFamily } from './tenants.js';

/*
  The plan's letters and its last consequence (#265). Once a day every
  active family's entitlement is derived and four occasions are checked:
  the free period ends in a week, it ends tomorrow, the hub has just gone
  read-only, the data goes in a week. Each letter goes to the family's
  administrators exactly once per occasion — the registry remembers what
  was sent, keyed by the date it was about, so a subscription that moves
  the date earns a fresh set. The fifth kind of letter the privacy policy
  names; the terms promise the two before removal.

  Removal itself is the same as self-deletion, sixty days after read-only
  began. Nothing here reads family content: recipients are the admin rows.
*/

const DAY_MS = 24 * 60 * 60_000;

function adminAddresses(familyId: string): string[] {
  return runWithTenant(tenantForFamily(familyId), () =>
    (db.prepare("SELECT email FROM users WHERE role = 'admin'").all() as { email: string }[]).map((u) => u.email),
  );
}

interface Letter {
  kind: string;
  subject: string;
  text: string;
}

function letterFor(e: Entitlement, slug: string, nowMs: number): Letter | null {
  const apex = env.hostedDomain;
  const hub = `https://${slug}.${apex}/settings`;
  const checkout = `https://${apex}/checkout?family=${encodeURIComponent(slug)}`;
  const day = (iso: string) => iso.slice(0, 10);
  const closing = [
    '',
    `Subscribe from Settings → Plan (${hub}) or directly: ${checkout}`,
    'One plan covers the whole family: €4.99 a month or €44.99 a year, cancel anytime.',
    'Everything you have put in stays yours — the complete archive is one click away in Settings, always.',
    '',
    `Questions: https://support.${apex}`,
  ];

  if (!e.readOnly && e.until && !e.subscribed) {
    const left = (Date.parse(e.until) - nowMs) / DAY_MS;
    if (left <= 1) {
      return {
        kind: `ends-1d:${day(e.until)}`,
        subject: 'Your free period ends tomorrow',
        text: ['Hello.', '', `The free period of your family's hub ends on ${day(e.until)}. After that the hub`,
          'becomes read-only: everyone can still sign in, read everything and export the archive,',
          'but nothing can be added or changed — for 60 days, then the data is removed.', ...closing].join('\n'),
      };
    }
    if (left <= 7) {
      return {
        kind: `ends-7d:${day(e.until)}`,
        subject: 'Your free period ends in a week',
        text: ['Hello.', '', `The free period of your family's hub ends on ${day(e.until)}. Nothing happens`,
          'before then; afterwards the hub is read-only until the family subscribes.', ...closing].join('\n'),
      };
    }
  }
  if (e.readOnly && e.until && e.deleteAt) {
    const untilDelete = (Date.parse(e.deleteAt) - nowMs) / DAY_MS;
    if (untilDelete <= 7) {
      return {
        kind: `delete-7d:${day(e.deleteAt)}`,
        subject: "Your family's data will be removed in a week",
        text: ['Hello.', '', `Your family's hub has been read-only since ${day(e.until)}. On ${day(e.deleteAt)} the data`,
          'is removed, as the terms say. Until then everything can still be exported from Settings,',
          'and subscribing brings the hub back exactly as it was.', ...closing].join('\n'),
      };
    }
    return {
      kind: `read-only:${day(e.until)}`,
      subject: "Your family's hub is now read-only",
      text: ['Hello.', '', `Your family's hub became read-only on ${day(e.until)}: everyone can sign in, read and`,
        `export, but nothing can be added or changed. It stays that way until ${day(e.deleteAt)}, when the`,
        'data is removed. Subscribing at any point before then brings everything back.', ...closing].join('\n'),
      };
  }
  return null;
}

/** One pass: letters due today, and removals whose day has come. Returns counts. */
export async function sweepPlans(nowMs = Date.now()): Promise<{ letters: number; removed: number }> {
  let letters = 0;
  let removed = 0;
  let mailWarned = false;
  for (const family of familiesWithPlans()) {
    const e = entitlement(family, nowMs);
    if (e.readOnly && e.deleteAt && Date.parse(e.deleteAt) <= nowMs) {
      deleteFamilyData(family.id);
      removed += 1;
      continue;
    }
    const letter = letterFor(e, family.slug, nowMs);
    if (!letter) continue;
    if (!serviceMailAvailable()) {
      if (!mailWarned) log.warn('plan: letters are due but service mail is not configured');
      mailWarned = true;
      continue;
    }
    const recipients = adminAddresses(family.id);
    if (recipients.length === 0) continue;
    if (!recordPlanLetter(family.id, letter.kind)) continue;
    for (const to of recipients) {
      try {
        await sendServiceEmail(to, letter.subject, letter.text);
        letters += 1;
      } catch (err) {
        log.error(`plan: letter "${letter.kind}" to ${family.slug} failed`, err);
      }
    }
  }
  if (letters || removed) log.notice(`plan: ${letters} letters sent, ${removed} families removed`);
  return { letters, removed };
}

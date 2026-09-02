/**
 * The family's timezone on the client.
 *
 * The hub is a shared board, so "today" has to mean the same day for every
 * member: a parent on a trip must not see a task the rest of the house calls
 * due tomorrow. So "today" is the family's day, not the browser's — the same
 * value the server computes from settings key `home.timezone`.
 *
 * Note what this is NOT for. Events and reminders are stored as local
 * wall-clock strings with no zone and are meant to round-trip unconverted
 * (see PublicEvent.tsx), and sign-in stamps are genuine instants best read on
 * the viewer's own clock (formatStamp in format.ts). Neither goes through
 * here. Only "what day is it right now" does.
 */

/** Settings key holding the family's IANA zone name. */
export const TIMEZONE_KEY = 'home.timezone';

/** The zone the browser reports — the default until settings arrive. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/*
  Module state rather than context: today() is called from render bodies all
  over the tree and threading a prop through every one of them buys nothing.
  The default is the browser's zone, which is what the app used before family
  zones existed — so the window between first paint and settings arriving
  behaves exactly as the old build did, rather than wrongly.
*/
let zone = browserTimezone();

/** Called once when settings load. Absent or unusable falls back to the browser. */
export function setFamilyTimezone(tz: string | undefined | null): void {
  const next = tz?.trim();
  zone = next && isValidTimezone(next) ? next : browserTimezone();
}

export function familyTimezone(): string {
  return zone;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The date in `tz` at instant `at`, as YYYY-MM-DD.
 *
 * Assembled from parts rather than read off a locale that happens to print in
 * ISO order: the part types are a contract, a locale's output shape is not.
 * Mirrors dayIn in server/src/lib/timezone.ts — the two must agree.
 */
export function dayIn(tz: string, at: Date): string {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(tz, formatter);
  }
  const parts = formatter.formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Zone names this runtime can offer in a picker, canonical names only. */
export function knownTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

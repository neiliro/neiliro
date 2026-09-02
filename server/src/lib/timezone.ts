/**
 * Family timezones.
 *
 * The hub has always run on local wall time rather than UTC — that part is
 * deliberate. What was not deliberate is that "local" meant the *server's*
 * clock, one for every family: a family in Chicago living on an Amsterdam
 * process saw "today" flip in the middle of their afternoon, and with it
 * their due tasks, recurring transactions and budget periods.
 *
 * So the day is computed in the family's own zone, stored as an IANA name
 * under the settings key `home.timezone`. A family without one keeps the
 * process clock, which is exactly the old behaviour — that is why this
 * needed no migration and why self-hosted hubs are untouched.
 *
 * No library: Intl already carries the IANA database, and the strict CSP
 * habit of not pulling third-party code in for something the platform does
 * applies on the server too.
 */

/*
  Constructing an Intl.DateTimeFormat is the expensive part — the lookup
  into the timezone database happens there, not in format(). There are as
  many of these as there are distinct family zones on the process, so a
  plain Map is the whole cache story.
*/
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
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
  return formatter;
}

/**
 * The date in `tz` at instant `at`, as YYYY-MM-DD.
 *
 * Assembled from parts rather than read off a locale that happens to print
 * in ISO order (en-CA does today): the part types are a contract, the shape
 * of a locale's output is not.
 */
export function dayIn(tz: string, at: Date): string {
  const parts = formatterFor(tz).formatToParts(at);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The date by the process clock — what every family got before this. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
    at.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Whether the runtime can actually use this zone name.
 *
 * Deliberately a construction attempt rather than a membership test against
 * Intl.supportedValuesOf('timeZone'): that list is canonical names only, so
 * it would reject the aliases (Asia/Calcutta, US/Pacific) that older clients
 * still report and that format perfectly well. The question worth asking is
 * "will dayIn work with this", and this is that question.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

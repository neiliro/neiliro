/*
  iCalendar (RFC 5545) output for the subscribe-by-URL feed.

  Written by hand rather than pulled in as a dependency: the subset we
  need is small, and the project keeps its dependency list short on
  purpose.

  The important decision is time. Events are stored as local wall-clock
  strings ("2026-08-20T10:00") because that is what this hub means by a
  time — the same convention as everywhere else in the codebase. In
  iCalendar that is *floating* time: a DTSTART with no zone and no Z,
  which every client interprets in the device's own zone. So a 9am school
  run stays 9am, which is the honest translation of what the family typed.
  Converting to UTC here would invent a timezone the hub never recorded.
*/

export interface FeedEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  /** Local wall-clock: "2026-08-20T10:00", or "2026-08-20" for all-day */
  starts_at: string;
  ends_at: string;
  all_day: number;
  /** RRULE subset as stored: "FREQ=WEEKLY;INTERVAL=2" */
  recurrence_rule: string | null;
  /** When the row last changed, for LAST-MODIFIED. UTC, as the column stores it. */
  updated_at?: string | null;
}

/** Text escaping per RFC 5545 §3.3.11. */
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** "2026-08-20T10:00" -> "20260820T100000"; "2026-08-20" -> "20260820". */
function stamp(value: string): string {
  const compact = value.replace(/[-:]/g, '');
  // Seconds are appended with a function replacement on purpose: "T$100"
  // in a string replacement reads as group 10, not group 1 plus "00".
  return compact.replace(/T(\d{4})$/, (_, hhmm: string) => `T${hhmm}00`);
}

/*
  updated_at reaches us in one of two shapes: SQLite's own
  "2026-08-26 08:00:00" from the column default, or an ISO string when the
  row was written by application code. Both are UTC; neither is worth a
  migration to unify, so this normalises instead of assuming.
*/
function utcStamp(value: string): string | null {
  const parsed = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

/** All-day DTEND is exclusive, so the last day needs one added. */
function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d!) + 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

/*
  Lines are folded at 75 octets (§3.1). Clients are mostly forgiving, but
  a long DESCRIPTION is exactly where the unforgiving ones break, and
  that is the field a family fills with detail.
*/
function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const char of line) {
    // Continuation lines carry a leading space, so they hold one octet less
    const limit = out.length === 0 ? 75 : 74;
    if (Buffer.byteLength(current + char, 'utf8') > limit) {
      out.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  out.push(current);
  return out.join('\r\n ');
}

export function buildCalendarFeed(
  calendarName: string,
  events: FeedEvent[],
  generatedAt: Date,
): string {
  const utc = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Neiliro//Family hub//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calendarName)}`,
    // A hint for how often to re-poll; clients treat it as advice
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    // Stable across regenerations: a client updates the event it already
    // has instead of creating a duplicate
    lines.push(`UID:${event.id}@neiliro`);
    lines.push(`DTSTAMP:${utc(generatedAt)}`);
    if (event.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${stamp(event.starts_at.slice(0, 10))}`);
      lines.push(`DTEND;VALUE=DATE:${stamp(dayAfter(event.ends_at.slice(0, 10)))}`);
    } else {
      lines.push(`DTSTART:${stamp(event.starts_at)}`);
      lines.push(`DTEND:${stamp(event.ends_at)}`);
    }
    lines.push(`SUMMARY:${esc(event.title)}`);
    if (event.description) lines.push(`DESCRIPTION:${esc(event.description)}`);
    if (event.location) lines.push(`LOCATION:${esc(event.location)}`);
    /*
      The stored rule is already a valid RRULE — the hub keeps a subset of
      RFC 5545 (FREQ plus INTERVAL), so it travels as-is and the client
      expands it. Expanding here instead would mean choosing a window and
      re-sending hundreds of copies of the same weekly event.
    */
    if (event.recurrence_rule) lines.push(`RRULE:${event.recurrence_rule}`);
    /*
      How a client knows the event changed rather than just re-arrived.
      SEQUENCE is deliberately not sent: it has to increase on every edit,
      and the hub keeps no revision counter — a fabricated one that ever
      went backwards would make clients ignore real updates. For a
      PUBLISH-method subscription LAST-MODIFIED is what clients actually
      compare.
    */
    const modified = event.updated_at ? utcStamp(event.updated_at) : null;
    if (modified) lines.push(`LAST-MODIFIED:${modified}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

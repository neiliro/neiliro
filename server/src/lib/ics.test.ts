import { describe, expect, it } from 'vitest';
import { buildCalendarFeed, type FeedEvent } from './ics.js';

/*
  The feed is read by Apple, Google and Outlook, none of which we can
  test against here — so the tests pin the parts of RFC 5545 that those
  clients are strict about, and the one project-specific decision:
  local wall-clock times travel as floating time, never converted to UTC.
*/

const AT = new Date('2026-08-26T08:00:00Z');

function event(over: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: 'e1',
    title: 'School run',
    description: null,
    location: null,
    starts_at: '2026-08-20T09:00',
    ends_at: '2026-08-20T09:30',
    all_day: 0,
    recurrence_rule: null,
    ...over,
  };
}

const lines = (ics: string) => ics.split('\r\n');

describe('buildCalendarFeed', () => {
  it('wraps events in a valid calendar envelope', () => {
    const out = lines(buildCalendarFeed('Family', [event()], AT));
    expect(out[0]).toBe('BEGIN:VCALENDAR');
    expect(out).toContain('VERSION:2.0');
    expect(out).toContain('X-WR-CALNAME:Family');
    expect(out).toContain('BEGIN:VEVENT');
    expect(out).toContain('END:VEVENT');
    expect(out.at(-2)).toBe('END:VCALENDAR');
    // CRLF endings, including the final one (§3.1)
    expect(buildCalendarFeed('Family', [], AT).endsWith('\r\n')).toBe(true);
  });

  it('sends a timed event as floating local time, not UTC', () => {
    const out = lines(buildCalendarFeed('Family', [event()], AT));
    // 09:00 stays 09:00 in the reader's zone — the hub never recorded a
    // zone, so inventing one here would move the event
    expect(out).toContain('DTSTART:20260820T090000');
    expect(out).toContain('DTEND:20260820T093000');
    expect(out.some((l) => /^DTSTART.*Z$/.test(l))).toBe(false);
  });

  it('sends an all-day event as a date, with the exclusive end', () => {
    const out = lines(
      buildCalendarFeed(
        'Family',
        [event({ all_day: 1, starts_at: '2026-08-20', ends_at: '2026-08-20' })],
        AT,
      ),
    );
    expect(out).toContain('DTSTART;VALUE=DATE:20260820');
    // DTEND is exclusive: a one-day event ends on the 21st
    expect(out).toContain('DTEND;VALUE=DATE:20260821');
  });

  it('crosses a month boundary correctly for all-day events', () => {
    const out = lines(
      buildCalendarFeed(
        'Family',
        [event({ all_day: 1, starts_at: '2026-08-31', ends_at: '2026-08-31' })],
        AT,
      ),
    );
    expect(out).toContain('DTEND;VALUE=DATE:20260901');
  });

  it('passes the stored recurrence rule through as RRULE', () => {
    const out = lines(buildCalendarFeed('Family', [event({ recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2' })], AT));
    // The hub stores a subset of RFC 5545, so it is already valid here —
    // and the client expands it, instead of us shipping hundreds of copies
    expect(out).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2');
  });

  it('escapes the characters that would otherwise break a line', () => {
    const out = buildCalendarFeed(
      'Family',
      [event({ title: 'Dentist; bring card, please', description: 'Line one\nline two \\ done' })],
      AT,
    );
    // Both are escaped in the output: "\;" and "\," — note that writing
    // '\;' in a JS string would be a plain semicolon, which is the trap
    // this expectation fell into first time round.
    expect(out).toContain('SUMMARY:Dentist\\; bring card\\, please');
    expect(out).toContain('DESCRIPTION:Line one\\nline two \\\\ done');
  });

  it('folds long lines and keeps continuations marked', () => {
    const long = 'A'.repeat(200);
    const out = lines(buildCalendarFeed('Family', [event({ description: long })], AT));
    const folded = out.filter((l) => l.startsWith(' '));
    expect(folded.length).toBeGreaterThan(0);
    // No line exceeds the 75-octet limit
    expect(out.every((l) => Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
  });

  it('reports LAST-MODIFIED so a client can tell an edit from a re-arrival', () => {
    // Both storage shapes appear in practice: SQLite's column default and
    // an ISO string from application code. Both are UTC.
    const sqliteShape = lines(buildCalendarFeed('Family', [event({ updated_at: '2026-08-25 14:30:00' })], AT));
    expect(sqliteShape).toContain('LAST-MODIFIED:20260825T143000Z');

    const isoShape = lines(buildCalendarFeed('Family', [event({ updated_at: '2026-08-25T14:30:00.000Z' })], AT));
    expect(isoShape).toContain('LAST-MODIFIED:20260825T143000Z');
  });

  it('omits LAST-MODIFIED rather than inventing one', () => {
    const out = lines(buildCalendarFeed('Family', [event({ updated_at: null })], AT));
    expect(out.some((l) => l.startsWith('LAST-MODIFIED'))).toBe(false);
    // And a value that cannot be parsed is dropped, not passed through:
    // a malformed date makes some clients discard the whole event
    const bad = lines(buildCalendarFeed('Family', [event({ updated_at: 'not a date' })], AT));
    expect(bad.some((l) => l.startsWith('LAST-MODIFIED'))).toBe(false);
    expect(bad).toContain('SUMMARY:School run');
  });

  it('never sends SEQUENCE, which it has no counter to back', () => {
    const out = lines(buildCalendarFeed('Family', [event({ updated_at: '2026-08-25 14:30:00' })], AT));
    // A fabricated sequence that ever went backwards would make clients
    // ignore genuine updates
    expect(out.some((l) => l.startsWith('SEQUENCE'))).toBe(false);
  });

  it('gives every event a stable uid, so a re-poll updates instead of duplicating', () => {
    const first = buildCalendarFeed('Family', [event()], AT);
    const later = buildCalendarFeed('Family', [event()], new Date('2026-09-01T08:00:00Z'));
    expect(first).toContain('UID:e1@neiliro');
    expect(later).toContain('UID:e1@neiliro');
  });
});

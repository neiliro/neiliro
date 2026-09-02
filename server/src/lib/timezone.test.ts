import { describe, expect, it } from 'vitest';
import { dayIn, isValidTimezone, localDay } from './timezone.js';

/*
  The whole point of family timezones is that two families can disagree
  about what day it is, so that is what these check first. The rest guard
  the two ways a naive implementation gets it wrong — whole-hour offset
  arithmetic, and a DST switch moving the date.
*/
describe('dayIn', () => {
  it('gives two families different days at the same instant', () => {
    // 05:30 in Amsterdam, still 21:30 the previous evening in California
    const at = new Date('2026-03-15T04:30:00Z');
    expect(dayIn('Europe/Amsterdam', at)).toBe('2026-03-15');
    expect(dayIn('America/Los_Angeles', at)).toBe('2026-03-14');
  });

  it('handles a zone offset by half an hour', () => {
    // 00:15 in Kolkata (+05:30) while Greenwich is still on the day before.
    // An implementation doing whole-hour arithmetic gets this one wrong.
    const at = new Date('2026-01-01T18:45:00Z');
    expect(dayIn('Asia/Kolkata', at)).toBe('2026-01-02');
    expect(dayIn('UTC', at)).toBe('2026-01-01');
  });

  it('does not let a DST switch move the date', () => {
    // New York springs forward at 02:00 local on 2026-03-08. Either side of
    // the jump is the same calendar day, and must be reported as one.
    expect(dayIn('America/New_York', new Date('2026-03-08T06:30:00Z'))).toBe('2026-03-08');
    expect(dayIn('America/New_York', new Date('2026-03-08T07:30:00Z'))).toBe('2026-03-08');
  });

  it('pads month and day to a sortable YYYY-MM-DD', () => {
    // Dates are compared as strings throughout (isOverdue, expandOccurrences)
    expect(dayIn('UTC', new Date('2026-02-03T12:00:00Z'))).toBe('2026-02-03');
  });
});

describe('localDay', () => {
  it('agrees with dayIn for the process zone', () => {
    const at = new Date('2026-06-15T12:00:00Z');
    expect(localDay(at)).toBe(dayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, at));
  });
});

describe('isValidTimezone', () => {
  it('accepts canonical names', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('accepts the aliases older clients still report', () => {
    // The reason this is a construction attempt and not a membership test
    // against Intl.supportedValuesOf, which lists canonical names only
    expect(isValidTimezone('Asia/Calcutta')).toBe(true);
    expect(isValidTimezone('US/Pacific')).toBe(true);
  });

  it('rejects anything the runtime cannot format with', () => {
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Europe/Amsterdam ')).toBe(false);
  });

  it('accepts a fixed offset, which the runtime does support', () => {
    // Documented rather than desired: the picker only ever offers IANA
    // names, and a fixed offset could reach us only through a hand-made
    // request or a restored database. It formats correctly — it just has
    // no DST, which is the caller's problem and not a reason to fail late.
    expect(isValidTimezone('+03:00')).toBe(true);
  });
});

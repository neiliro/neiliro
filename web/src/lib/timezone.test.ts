import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimezone, dayIn, isValidTimezone, setFamilyTimezone } from './timezone';
import { today } from './tasks';

/*
  The client half of family timezones. dayIn mirrors the server's version
  and the two must agree — a board that disagrees with the API about what
  "today" is shows tasks as overdue on one side and not the other.
*/
afterEach(() => {
  vi.useRealTimers();
  setFamilyTimezone(undefined);
});

describe('dayIn', () => {
  it('gives two families different days at the same instant', () => {
    const at = new Date('2026-03-15T04:30:00Z');
    expect(dayIn('Europe/Amsterdam', at)).toBe('2026-03-15');
    expect(dayIn('America/Los_Angeles', at)).toBe('2026-03-14');
  });

  it('handles a zone offset by half an hour', () => {
    const at = new Date('2026-01-01T18:45:00Z');
    expect(dayIn('Asia/Kolkata', at)).toBe('2026-01-02');
    expect(dayIn('UTC', at)).toBe('2026-01-01');
  });

  it('does not let a DST switch move the date', () => {
    expect(dayIn('America/New_York', new Date('2026-03-08T06:30:00Z'))).toBe('2026-03-08');
    expect(dayIn('America/New_York', new Date('2026-03-08T07:30:00Z'))).toBe('2026-03-08');
  });
});

describe('setFamilyTimezone', () => {
  it('falls back to the browser when the family has set nothing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    setFamilyTimezone(undefined);
    expect(today()).toBe(dayIn(browserTimezone(), new Date()));
  });

  it('falls back to the browser rather than trusting an unusable zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    setFamilyTimezone('Mars/Olympus_Mons');
    expect(today()).toBe(dayIn(browserTimezone(), new Date()));
  });

  it('makes today the family\'s day, not this browser\'s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    setFamilyTimezone('America/Los_Angeles');
    expect(today()).toBe('2026-03-14');

    setFamilyTimezone('Europe/Amsterdam');
    expect(today()).toBe('2026-03-15');
  });

  it('treats an empty setting as unset', () => {
    // What the picker sends for "Follow the server clock"
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    setFamilyTimezone('');
    expect(today()).toBe(dayIn(browserTimezone(), new Date()));
  });
});

describe('isValidTimezone', () => {
  it('accepts canonical names and the aliases older clients report', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('Asia/Calcutta')).toBe(true);
  });

  it('rejects what the runtime cannot format with', () => {
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

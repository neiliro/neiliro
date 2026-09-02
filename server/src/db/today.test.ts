import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateTimezone, openDatabase, runWithDb, today } from './index.js';
import { migrate } from './migrate.js';
import { localDay } from '../lib/timezone.js';

/*
  today() is the single place the hub reads a wall clock, so it is the
  single place a family's timezone can enter. These pin the behaviour the
  rest of the product is built on: two families on one process disagreeing
  about the date, and a family without a setting keeping exactly what it
  had before the setting existed.
*/
function familyIn(tz?: string) {
  const db = openDatabase(':memory:');
  runWithDb(db, () => {
    migrate();
    if (tz !== undefined) {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('home.timezone', ?, '')").run(
        tz,
      );
    }
  });
  return db;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('today', () => {
  it('gives two families different dates at the same instant', () => {
    vi.useFakeTimers();
    // 05:30 in Amsterdam, still the previous evening in California
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const amsterdam = familyIn('Europe/Amsterdam');
    const california = familyIn('America/Los_Angeles');

    expect(runWithDb(amsterdam, () => today())).toBe('2026-03-15');
    expect(runWithDb(california, () => today())).toBe('2026-03-14');
  });

  it('follows the process clock when the family has set no zone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const db = familyIn();
    expect(runWithDb(db, () => today())).toBe(localDay(new Date()));
  });

  it('ignores a stored zone the runtime cannot use', () => {
    // A database can arrive by restore or import, not only through the API
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const db = familyIn('Mars/Olympus_Mons');
    expect(runWithDb(db, () => today())).toBe(localDay(new Date()));
  });

  it('picks up a change once the cache is invalidated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const db = familyIn('Europe/Amsterdam');
    runWithDb(db, () => {
      expect(today()).toBe('2026-03-15');

      db.prepare("UPDATE settings SET value = 'America/Los_Angeles' WHERE key = 'home.timezone'").run();
      // Still cached on the tenant: the write alone must not be enough
      expect(today()).toBe('2026-03-15');

      invalidateTimezone();
      expect(today()).toBe('2026-03-14');
    });
  });

  it('does not leak a cached zone into another database', () => {
    // runWithDb spreads the default tenant, which carries a cache slot
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T04:30:00Z'));

    const california = familyIn('America/Los_Angeles');
    const plain = familyIn();

    expect(runWithDb(california, () => today())).toBe('2026-03-14');
    expect(runWithDb(plain, () => today())).toBe(localDay(new Date()));
    expect(runWithDb(california, () => today())).toBe('2026-03-14');
  });
});

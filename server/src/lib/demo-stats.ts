import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { openDatabase } from '../db/index.js';
import { env } from '../env.js';
import { log } from './log.js';

/*
  Usage statistics for the public demo.

  One row per sandbox: born on demo login, closed when the sandbox dies.
  The numbers answer the only questions that matter for a public demo —
  does anyone come, do they stay past the first click, and which parts
  of the hub do they actually try.

  The rows live in their own tiny database (demo-stats.db) next to the
  app data. Not in the app schema: migrations describe family data, and
  a stats table would ship to every self-hosted install that never runs
  a demo. Not under demo/ either: that directory is wiped on every
  start, while statistics are precisely the thing that must survive
  restarts and template rebuilds.

  Privacy: no IPs and no visitor identifiers are stored — the referrer
  host and the kind of device (phone / tablet / desktop, never the
  user-agent string itself) are as personal as it gets. Stats are
  also strictly best-effort: a failure here must never break the demo
  itself, so every write swallows its errors into a warn line.
*/

export type EndReason = 'logout' | 'idle' | 'oversize' | 'lru' | 'shutdown';

let statsDb: Database.Database | null = null;

/**
 * Local wall-clock timestamp, matching the project-wide convention
 * (see today() in db/index.ts): the report groups sessions by the day
 * the family would name, not the Greenwich one.
 */
function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export function initDemoStats(): void {
  try {
    statsDb = openDatabase(join(env.dataDir, 'demo-stats.db'));
    statsDb.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        referrer   TEXT,
        user_agent TEXT,
        ended_at   TEXT,
        end_reason TEXT,
        requests   INTEGER NOT NULL DEFAULT 0,
        writes     INTEGER NOT NULL DEFAULT 0,
        modules    TEXT NOT NULL DEFAULT ''
      )
    `);
  } catch (err) {
    statsDb = null;
    log.warn('demo stats: disabled, the database failed to open', err);
  }
}

/** Flushes the WAL so the file is whole — for graceful shutdown. */
export function closeDemoStats(): void {
  try {
    statsDb?.close();
  } catch (err) {
    log.warn('demo stats: database failed to close', err);
  }
  statsDb = null;
}

/**
 * The raw value is document.referrer sent by the client — an URL.
 * Only host + path are kept: the query string of the referring page is
 * where tracking junk lives, and it answers no question of ours.
 */
export function normalizeReferrer(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return (u.host + u.pathname.replace(/\/+$/, '')).slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

/*
  Route prefix → product module. Grouping happens at write time so the
  report stays a dumb GROUP BY: the API splits one product area across
  several prefixes (money alone owns five), and nobody reading the
  numbers thinks in prefixes.
*/
const MODULE_BY_PREFIX: Record<string, string> = {
  tasks: 'tasks',
  projects: 'tasks',
  notes: 'notes',
  folders: 'notes',
  attachments: 'notes',
  calendars: 'calendar',
  events: 'calendar',
  money: 'money',
  accounts: 'money',
  categories: 'money',
  transactions: 'money',
  recurring: 'money',
  budgets: 'budgets',
  dashboard: 'dashboard',
  search: 'search',
  settings: 'settings',
  users: 'settings',
  household: 'settings',
  invites: 'settings',
};

/**
 * Which product module an API request belongs to; null for requests that
 * say nothing about engagement (auth, health, static files). An unknown
 * prefix passes through as-is, so a future module shows up in the report
 * without anyone remembering this map exists.
 */
export function apiModule(url: string): string | null {
  if (!url.startsWith('/api/')) return null;
  const seg = url.slice('/api/'.length).split(/[/?]/, 1)[0] ?? '';
  if (!seg || seg === 'auth' || seg === 'health') return null;
  return MODULE_BY_PREFIX[seg] ?? seg;
}

/**
 * The one thing the counters want from a user-agent string — was this a
 * phone, a tablet or a desktop — without keeping the string itself. A raw
 * user agent is a fingerprint in all but name (browser build, OS version,
 * device model), which is more than "anonymous counters about demo
 * visits" may hold. The column keeps its historical name.
 */
export function deviceClass(userAgent: string | null | undefined): 'phone' | 'tablet' | 'desktop' | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/.test(ua)) return 'phone';
  return 'desktop';
}

/** Records a fresh sandbox; returns the row id to close later (null when stats are off). */
export function statsSessionStarted(
  referrer: string | null | undefined,
  userAgent: string | null | undefined,
): number | null {
  if (!statsDb) return null;
  try {
    const result = statsDb
      .prepare('INSERT INTO sandbox_sessions (created_at, referrer, user_agent) VALUES (?, ?, ?)')
      .run(localNow(), normalizeReferrer(referrer), deviceClass(userAgent));
    return Number(result.lastInsertRowid);
  } catch (err) {
    log.warn('demo stats: session start failed to record', err);
    return null;
  }
}

export function statsSessionEnded(
  rowId: number | null,
  reason: EndReason,
  counters: { requests: number; writes: number; modules: ReadonlySet<string> },
): void {
  if (!statsDb || rowId === null) return;
  try {
    statsDb
      .prepare(
        `UPDATE sandbox_sessions
            SET ended_at = ?, end_reason = ?, requests = ?, writes = ?, modules = ?
          WHERE id = ?`,
      )
      .run(
        localNow(),
        reason,
        counters.requests,
        counters.writes,
        [...counters.modules].sort().join(','),
        rowId,
      );
  } catch (err) {
    log.warn('demo stats: session end failed to record', err);
  }
}

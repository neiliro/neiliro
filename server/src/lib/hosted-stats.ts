import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { openDatabase, today } from '../db/index.js';
import { env } from '../env.js';
import { apiModule } from './demo-stats.js';
import { log } from './log.js';

/*
  Activity statistics for hosted mode — the demo-stats idea grown up:
  one row per FAMILY per DAY, counters only. The numbers answer the
  operator's questions (is a family alive, do both adults use it, which
  modules matter) without ever reading family content — the same privacy
  stance as the demo: counters, not data.

  The rows live in their own database (hosted-stats.db) next to the
  registry. Not in the app schema: migrations describe family data, and
  these rows describe the service. Deleting a family leaves its history
  here — the history is the operator's, not the family's.

  User identifiers never touch the disk: the per-day set of active users
  lives in memory and only its SIZE is stored. The cost is a soft
  undercount when the process restarts mid-day (the set starts empty and
  the flush merges with max()) — accepted: deploys are occasional, and
  an undercount can only delay a "both adults active" verdict, never
  fake one.

  Everything here is best-effort: a stats failure must never break a
  family's request, so writes swallow their errors into warn lines.
*/

interface DayAccumulator {
  day: string;
  /** Deltas since the last flush — flushed additively, then reset. */
  requests: number;
  writes: number;
  modules: Map<string, number>;
  /** Cumulative for the whole day — flushed via max(), never reset. */
  users: Set<string>;
}

let statsDb: Database.Database | null = null;
const accumulators = new Map<string, DayAccumulator>();

const FLUSH_MS = 10 * 60_000;

export function initHostedStats(): void {
  try {
    statsDb = openDatabase(join(env.dataDir, 'hosted-stats.db'));
    statsDb.exec(`
      CREATE TABLE IF NOT EXISTS family_days (
        family_id    TEXT NOT NULL,
        day          TEXT NOT NULL,
        requests     INTEGER NOT NULL DEFAULT 0,
        writes       INTEGER NOT NULL DEFAULT 0,
        active_users INTEGER NOT NULL DEFAULT 0,
        modules      TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (family_id, day)
      )
    `);
    setInterval(flushHostedStats, FLUSH_MS).unref();
  } catch (err) {
    statsDb = null;
    log.warn('hosted stats: disabled, the database failed to open', err);
  }
}

/**
 * Counts one request against its family's current day. Called after
 * auth (the user id is part of the count) and only for module requests —
 * apiModule() filters out auth, health and static noise, so "active"
 * means "touched the product", the same bar the demo sets.
 */
export function trackFamilyRequest(
  familyId: string,
  method: string,
  url: string,
  userId: string | undefined,
): void {
  if (!statsDb) return;
  const module = apiModule(url);
  if (!module) return;

  const day = today();
  let acc = accumulators.get(familyId);
  if (acc && acc.day !== day) {
    // Midnight passed: close yesterday's row, start fresh (users reset —
    // "active today" starts over)
    flushFamily(familyId, acc);
    accumulators.delete(familyId);
    acc = undefined;
  }
  if (!acc) {
    acc = { day, requests: 0, writes: 0, modules: new Map(), users: new Set() };
    accumulators.set(familyId, acc);
  }

  acc.requests += 1;
  if (method !== 'GET' && method !== 'HEAD') acc.writes += 1;
  acc.modules.set(module, (acc.modules.get(module) ?? 0) + 1);
  if (userId) acc.users.add(userId);
}

function flushFamily(familyId: string, acc: DayAccumulator): void {
  if (!statsDb || acc.requests === 0) return;
  try {
    const existing = statsDb
      .prepare(
        'SELECT requests, writes, active_users, modules FROM family_days WHERE family_id = ? AND day = ?',
      )
      .get(familyId, acc.day) as
      | { requests: number; writes: number; active_users: number; modules: string }
      | undefined;

    if (existing) {
      const modules = JSON.parse(existing.modules) as Record<string, number>;
      for (const [name, count] of acc.modules) {
        modules[name] = (modules[name] ?? 0) + count;
      }
      statsDb
        .prepare(
          `UPDATE family_days
              SET requests = ?, writes = ?, active_users = ?, modules = ?
            WHERE family_id = ? AND day = ?`,
        )
        .run(
          existing.requests + acc.requests,
          existing.writes + acc.writes,
          Math.max(existing.active_users, acc.users.size),
          JSON.stringify(modules),
          familyId,
          acc.day,
        );
    } else {
      statsDb
        .prepare(
          `INSERT INTO family_days (family_id, day, requests, writes, active_users, modules)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          familyId,
          acc.day,
          acc.requests,
          acc.writes,
          acc.users.size,
          JSON.stringify(Object.fromEntries(acc.modules)),
        );
    }

    acc.requests = 0;
    acc.writes = 0;
    acc.modules.clear();
    // acc.users stays: it is the day's cumulative set behind the max()
  } catch (err) {
    log.warn('hosted stats: flush failed', err);
  }
}

export function flushHostedStats(): void {
  for (const [familyId, acc] of accumulators) flushFamily(familyId, acc);
}

/** Final flush and close — the WAL folds into the file for clean copies. */
export function shutdownHostedStats(): void {
  flushHostedStats();
  try {
    statsDb?.close();
  } catch (err) {
    log.warn('hosted stats: database failed to close', err);
  }
  statsDb = null;
  accumulators.clear();
}

import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { env } from '../env.js';
import {
  flushHostedStats,
  initHostedStats,
  shutdownHostedStats,
  trackFamilyRequest,
} from './hosted-stats.js';

/*
  The merge semantics carry the privacy promise: additive counters plus
  a max() on active_users mean a restart mid-day can only undercount,
  never double-count — and user ids themselves never reach the disk
  (nothing here ever hands them to the database).
*/
describe('hosted stats', () => {
  afterAll(() => shutdownHostedStats());

  it('accumulates counters and merges a mid-day restart with max()', () => {
    initHostedStats();

    trackFamilyRequest('fam-1', 'GET', '/api/tasks', 'user-a');
    trackFamilyRequest('fam-1', 'POST', '/api/tasks', 'user-a');
    trackFamilyRequest('fam-1', 'GET', '/api/money', 'user-b');
    // auth and health are not engagement — must not count
    trackFamilyRequest('fam-1', 'GET', '/api/auth/me', 'user-a');
    flushHostedStats();

    // A restart: accumulators (and the day's user set) start empty
    shutdownHostedStats();
    initHostedStats();
    trackFamilyRequest('fam-1', 'GET', '/api/tasks', 'user-b');
    flushHostedStats();

    const db = new Database(join(env.dataDir, 'hosted-stats.db'), { readonly: true });
    const row = db.prepare('SELECT * FROM family_days WHERE family_id = ?').get('fam-1') as {
      requests: number;
      writes: number;
      active_users: number;
      modules: string;
    };
    db.close();

    expect(row.requests).toBe(4);
    expect(row.writes).toBe(1);
    // 2 before the restart, 1 after — max keeps the better estimate
    expect(row.active_users).toBe(2);
    expect(JSON.parse(row.modules)).toEqual({ tasks: 3, money: 1 });
  });
});

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '../env.js';
import {
  apiModule,
  closeDemoStats,
  initDemoStats,
  normalizeReferrer,
  statsSessionEnded,
  statsSessionStarted,
} from './demo-stats.js';

describe('apiModule', () => {
  it('groups route prefixes into product modules', () => {
    expect(apiModule('/api/tasks/123')).toBe('tasks');
    expect(apiModule('/api/projects')).toBe('tasks');
    expect(apiModule('/api/transactions?limit=50')).toBe('money');
    expect(apiModule('/api/folders/abc')).toBe('notes');
    expect(apiModule('/api/events')).toBe('calendar');
    expect(apiModule('/api/invites')).toBe('settings');
  });

  it('ignores requests that say nothing about engagement', () => {
    expect(apiModule('/api/auth/me')).toBeNull();
    expect(apiModule('/api/health')).toBeNull();
    expect(apiModule('/assets/index-abc.js')).toBeNull();
    expect(apiModule('/')).toBeNull();
    expect(apiModule('/api/')).toBeNull();
  });

  it('passes an unknown prefix through so future modules show up unmapped', () => {
    expect(apiModule('/api/wishlists/1')).toBe('wishlists');
  });
});

describe('normalizeReferrer', () => {
  it('keeps host and path, drops the query string and trailing slash', () => {
    expect(normalizeReferrer('https://github.com/neiliro/neiliro/')).toBe(
      'github.com/neiliro/neiliro',
    );
    expect(normalizeReferrer('https://news.ycombinator.com/item?id=1')).toBe(
      'news.ycombinator.com/item',
    );
  });

  it('treats empty and absent values as no referrer', () => {
    expect(normalizeReferrer('')).toBeNull();
    expect(normalizeReferrer(null)).toBeNull();
    expect(normalizeReferrer(undefined)).toBeNull();
  });

  it('keeps a non-URL value as-is, truncated', () => {
    expect(normalizeReferrer('android-app://org.telegram.messenger')).toBe(
      'org.telegram.messenger',
    );
    expect(normalizeReferrer('not a url')).toBe('not a url');
    expect(normalizeReferrer('x'.repeat(500))).toHaveLength(200);
  });
});

describe('sandbox session lifecycle', () => {
  it('records start and end in demo-stats.db', () => {
    initDemoStats();
    const id = statsSessionStarted('https://github.com/neiliro/neiliro', 'TestAgent/1.0');
    expect(id).not.toBeNull();
    statsSessionEnded(id, 'logout', {
      requests: 7,
      writes: 2,
      modules: new Set(['tasks', 'notes']),
    });
    closeDemoStats();

    const db = new Database(join(env.dataDir, 'demo-stats.db'), { readonly: true });
    const row = db.prepare('SELECT * FROM sandbox_sessions WHERE id = ?').get(id) as {
      created_at: string;
      referrer: string;
      user_agent: string;
      ended_at: string;
      end_reason: string;
      requests: number;
      writes: number;
      modules: string;
    };
    db.close();

    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.referrer).toBe('github.com/neiliro/neiliro');
    expect(row.user_agent).toBe('TestAgent/1.0');
    expect(row.ended_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.end_reason).toBe('logout');
    expect(row.requests).toBe(7);
    expect(row.writes).toBe(2);
    // Modules are stored sorted, so the report never sees two spellings
    expect(row.modules).toBe('notes,tasks');
  });

  it('is a no-op when stats are off (null row id)', () => {
    expect(() =>
      statsSessionEnded(null, 'idle', { requests: 0, writes: 0, modules: new Set() }),
    ).not.toThrow();
  });
});

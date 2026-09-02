import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, runWithDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { env } from '../env.js';
import { seedDemo } from './demo.js';
import { DEMO_LANGS, type DemoLang } from './demo.strings.js';
import {
  type EndReason,
  apiModule,
  closeDemoStats,
  initDemoStats,
  statsSessionEnded,
  statsSessionStarted,
} from './demo-stats.js';
import { log } from './log.js';

/*
  Demo-mode sandboxes: every visitor gets their own copy of the database.

  All demo visitors used to live in one database: the first prankster
  filled it with garbage (or simply deleted everything), and the rest saw
  that until the nightly reset. Now demo login copies a template database —
  the visitor gets a fresh example and can do anything with it: nobody
  but them will ever see it.

  How it works:
  — the template is built at startup (migrations + seeding) and rebuilt
    once a day, because demo data is dated relative to "today";
  — copying the template is milliseconds and hundreds of kilobytes, the
    sandbox is created right in the login handler;
  — lifecycle: idle past TTL, file size overrun or registry overflow
    (LRU) — the sandbox is closed and its file deleted. The directory is
    wiped entirely at startup: restart = clean slate.
*/

export const SANDBOX_COOKIE = 'hub_sandbox';

const TTL_MS = 2 * 60 * 60_000; // two hours idle
const SWEEP_MS = 10 * 60_000;
const TEMPLATE_REBUILD_MS = 24 * 60 * 60_000;
const MAX_SANDBOXES = 100;
// An emergency brake against one sandbox ballooning from a write loop.
// The template weighs hundreds of kilobytes; honest poking around
// will never accumulate that much.
const MAX_DB_BYTES = 50 * 1024 * 1024;

const demoDir = join(env.dataDir, 'demo');
const sandboxesDir = join(demoDir, 'sandboxes');

/*
  One template per language, not one template plus a translation pass.

  The demo's content is seeded from a typed table (demo.strings.ts), so a
  language missing a string cannot compile; a pass that rewrote seeded rows
  afterwards would instead leave that string in English and say nothing.
  Templates are a few hundred kilobytes each and are built at startup, so
  the cost of the second one is milliseconds nobody is waiting on.
*/
const templatePath = (lang: DemoLang): string => join(demoDir, `template.${lang}.db`);

export interface Sandbox {
  id: string;
  db: Database.Database;
  file: string;
  lastSeen: number;
  /** Row in demo-stats.db to close when the sandbox dies (null — stats are off). */
  statsId: number | null;
  /** Which template this sandbox came from; a visitor who switches
   *  language is given a new sandbox rather than a translated one. */
  lang: DemoLang;
  requests: number;
  writes: number;
  modules: Set<string>;
}

const sandboxes = new Map<string, Sandbox>();

export async function initDemo(): Promise<void> {
  initDemoStats();

  // Orphaned files from the previous run are useless: the registry lives in memory
  rmSync(demoDir, { recursive: true, force: true });
  mkdirSync(sandboxesDir, { recursive: true });

  await buildTemplates();

  setInterval(sweep, SWEEP_MS).unref();
  setInterval(() => {
    buildTemplates().catch((err) => log.error('demo: template rebuild failed', err));
  }, TEMPLATE_REBUILD_MS).unref();

  log.block([
    '',
    '─'.repeat(64),
    '  DEMO MODE: every visitor gets a fresh throwaway sandbox.',
    `  Idle sandboxes are dropped after ${TTL_MS / 60_000} minutes.`,
    '─'.repeat(64),
    '',
  ]);
}

/**
 * The template is built into a temp file and swapped in atomically: a
 * sandbox created mid-rebuild copies either the old template or the new
 * one — never a half-built one.
 */
async function buildTemplate(lang: DemoLang): Promise<void> {
  const path = templatePath(lang);
  const tmp = `${path}.new`;
  rmSync(tmp, { force: true });

  const template = openDatabase(tmp);
  try {
    await runWithDb(template, async () => {
      migrate();
      await seedDemo(lang);
    });
  } finally {
    // close() flushes the WAL into the main file — the copy will be whole
    template.close();
  }
  renameSync(tmp, path);
  log.info(`demo: template built (${lang})`);
}

/*
  Every language is built eagerly, at startup, and a failure is left to
  propagate. A broken INSERT in the seeder has to take the demo server
  down where CI and the deploy can see it — building a language lazily on
  its first visitor would turn that into one stranger's 500.
*/
async function buildTemplates(): Promise<void> {
  for (const lang of DEMO_LANGS) await buildTemplate(lang);
}

export function createSandbox(
  meta: {
    referrer?: string | null;
    userAgent?: string | null;
  } = {},
  lang: DemoLang = 'en',
): Sandbox {
  if (sandboxes.size >= MAX_SANDBOXES) evictOldest();

  // The identifier is effectively the second half of authorization, hence
  // unpredictable. Only the value generated here goes into the file path;
  // the visitor's cookie is looked up strictly as a registry key.
  const id = randomBytes(16).toString('base64url');
  const file = join(sandboxesDir, `${id}.db`);
  copyFileSync(templatePath(lang), file);

  const sandbox: Sandbox = {
    id,
    db: openDatabase(file),
    file,
    lastSeen: Date.now(),
    statsId: statsSessionStarted(meta.referrer, meta.userAgent),
    lang,
    requests: 0,
    writes: 0,
    modules: new Set(),
  };
  sandboxes.set(id, sandbox);
  log.info(`demo: sandbox created, ${lang} (${sandboxes.size} active)`);
  return sandbox;
}

/**
 * Engagement counters for the stats row. Only API calls that say
 * something about the visitor count (see apiModule); the numbers stay
 * in memory on the sandbox and hit the disk once, at death.
 */
export function trackRequest(sandbox: Sandbox, method: string, url: string): void {
  const module = apiModule(url);
  if (!module) return;
  sandbox.requests += 1;
  if (method !== 'GET' && method !== 'HEAD') sandbox.writes += 1;
  sandbox.modules.add(module);
}

export function getSandbox(id: string): Sandbox | null {
  const sandbox = sandboxes.get(id);
  if (!sandbox) return null;
  sandbox.lastSeen = Date.now();
  return sandbox;
}

export function destroySandbox(id: string, reason: EndReason): void {
  const sandbox = sandboxes.get(id);
  if (!sandbox) return;
  sandboxes.delete(id);
  statsSessionEnded(sandbox.statsId, reason, sandbox);
  try {
    sandbox.db.close();
  } catch (err) {
    log.warn('demo: sandbox database failed to close', err);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${sandbox.file}${suffix}`, { force: true });
  }
}

/**
 * Graceful shutdown: close every stats row with an honest reason —
 * otherwise a deploy in the middle of someone's visit leaves a session
 * that never ended, and the report reads it as an eternal visitor.
 */
export function shutdownDemo(): void {
  for (const sandbox of [...sandboxes.values()]) destroySandbox(sandbox.id, 'shutdown');
  closeDemoStats();
}

function evictOldest(): void {
  let oldest: Sandbox | null = null;
  for (const sandbox of sandboxes.values()) {
    if (!oldest || sandbox.lastSeen < oldest.lastSeen) oldest = sandbox;
  }
  if (oldest) destroySandbox(oldest.id, 'lru');
}

function sweep(): void {
  const now = Date.now();
  for (const sandbox of [...sandboxes.values()]) {
    if (now - sandbox.lastSeen > TTL_MS) {
      destroySandbox(sandbox.id, 'idle');
    } else if (existsSync(sandbox.file) && statSync(sandbox.file).size > MAX_DB_BYTES) {
      destroySandbox(sandbox.id, 'oversize');
    }
  }
}

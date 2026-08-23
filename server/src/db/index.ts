import Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env, legacyDataDir, paths } from '../env.js';
import { log } from '../lib/log.js';

/**
 * One-time move of data from the old ./data to the new place.
 *
 * Plain file copying won't do: the database runs in WAL mode, and the
 * latest writes live not in hub.db but in the adjacent hub.db-wal. Copy
 * hub.db alone and you get a database without the fresh changes — and
 * without the password the person just set.
 *
 * So we open the database as a database and export it as a whole file:
 * SQLite honors the journal on open, and the output is a consistent copy.
 * The original is not deleted — if anything goes wrong, it stays put.
 */
function adoptLegacyData(): void {
  if (existsSync(paths.db)) return;
  if (legacyDataDir === env.dataDir) return;

  const legacyDb = join(legacyDataDir, 'hub.db');
  if (!existsSync(legacyDb)) return;

  mkdirSync(env.dataDir, { recursive: true });

  const source = new Database(legacyDb);
  try {
    source.exec(`VACUUM INTO '${paths.db.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  for (const dir of ['attachments', 'backups']) {
    const from = join(legacyDataDir, dir);
    if (existsSync(from)) cpSync(from, join(env.dataDir, dir), { recursive: true });
  }

  log.block([
    '',
    `  Data moved from ${legacyDataDir}`,
    `  to ${env.dataDir} — it no longer depends on code updates.`,
    '  The old copy is left in place; it is safe to delete.',
    '',
  ]);
}

adoptLegacyData();

mkdirSync(dirname(paths.db), { recursive: true });
mkdirSync(paths.attachments, { recursive: true });
mkdirSync(paths.backups, { recursive: true });

/**
 * Opening the database is a function because there can be more than one:
 * demo mode keeps a sandbox per visitor, and each must get the same
 * pragmas and the same registered functions as the main one — otherwise
 * queries using ci_contains would fail only inside sandboxes.
 */
export function openDatabase(file: string): Database.Database {
  const d = new Database(file);

  // WAL — concurrent reads during writes, matters for the wall display
  // polling the dashboard while someone is editing a note.
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('synchronous = NORMAL');
  d.pragma('busy_timeout = 5000');

  // SQLite's built-in lower() and LIKE are case-insensitive only for Latin:
  // «Справка» is not found by the query «справ». We register our own function
  // that folds case in JavaScript and therefore knows every alphabet.
  d.function('ci_contains', (haystack: unknown, needle: unknown) => {
    if (typeof haystack !== 'string' || typeof needle !== 'string') return 0;
    return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase()) ? 1 : 0;
  });

  return d;
}

const mainDb = openDatabase(paths.db);

/*
  Which family serves the current request.

  A tenant is a database plus the directories that belong to it: routing
  the database alone is not enough — attachments and backups are files
  on disk, and they must switch together with the data or one family's
  photos would land in another family's folder. Demo dodged this by
  blocking uploads in sandboxes; hosted mode cannot.

  In normal mode the context is always empty and the default tenant
  (the single family) does the work. In demo mode every visitor lives in
  their own sandbox; in hosted mode every family lives on its own
  subdomain (lib/tenants.ts). Either way a hook wraps the request in its
  tenant, and all code below — routes, auth, migrations, seeding —
  transparently works with it through the exported Proxy. No route knows
  about tenants.
*/
export interface Tenant {
  db: Database.Database;
  attachmentsDir: string;
  backupsDir: string;
  /** Registry id of the hosted family; absent for the single-family
   *  default, demo sandboxes and the ghost. See lib/tenants.ts */
  familyId?: string;
  /** Only the hosted decoy behind unknown subdomains. See lib/tenants.ts */
  ghost?: boolean;
}

const defaultTenant: Tenant = {
  db: mainDb,
  attachmentsDir: paths.attachments,
  backupsDir: paths.backups,
};

const dbContext = new AsyncLocalStorage<Tenant>();

export function currentTenant(): Tenant {
  return dbContext.getStore() ?? defaultTenant;
}

export function currentDb(): Database.Database {
  return currentTenant().db;
}

/** Run fn (async included) so that all code inside sees this tenant. */
export function runWithTenant<T>(tenant: Tenant, fn: () => T): T {
  return dbContext.run(tenant, fn);
}

/**
 * Database-only override: the file directories stay the default ones.
 * Enough for demo sandboxes and tests, where uploads are blocked or
 * irrelevant; hosted tenants must use runWithTenant.
 */
export function runWithDb<T>(d: Database.Database, fn: () => T): T {
  return dbContext.run({ ...defaultTenant, db: d }, fn);
}

/*
  The same better-sqlite3 interface, but methods always go to the current
  request's database. Statements are not cached at module level anywhere
  in the project (verified), so late binding at call time is enough.
*/
export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const d = currentDb();
    const value = Reflect.get(d, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(d) : value;
  },
});

export function id(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Today's date by the process's local clock (TZ), not UTC.
 *
 * toISOString() gives the Greenwich date: between midnight and +01/+02 it
 * is still yesterday's, and the dashboard and recurring transactions would
 * live in "yesterday". The frontend (web/src/lib/tasks.ts) computes
 * "today" the same way — by the local clock; the server must agree.
 */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

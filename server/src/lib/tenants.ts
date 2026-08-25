import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { id, now, openDatabase, runWithDb, runWithTenant, type Tenant } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { env } from '../env.js';
import { initHostedStats, shutdownHostedStats } from './hosted-stats.js';
import { log } from './log.js';

/*
  Hosted mode: many families on one server, routed by the Host header.

  family = subdomain = one SQLite file. The demo sandboxes proved the
  mechanism (a request wrapped in its own database via AsyncLocalStorage);
  this module replaces the mapping source: sandbox cookie → permanent
  family looked up by subdomain slug.

  The registry (registry.db next to the family folders) maps slug → family.
  A family's folder is named by its internal id, never the slug: renaming
  a slug is a registry update, the files don't move. Like demo-stats.db,
  the registry is not part of the app schema and has no migrations — it
  belongs to operating the service, not to the product.

  Unknown subdomains resolve to the ghost: an empty migrated in-memory
  database. Its login path answers exactly like a real family rejecting a
  wrong password (auth already runs a dummy scrypt for missing users, so
  even the timing matches), and /api/auth/state claims the hub is set up.
  From outside, a subdomain that doesn't exist is indistinguishable from
  one that does — nobody can enumerate families by probing names.
*/

const familiesDir = join(env.dataDir, 'families');

let registry: Database.Database | null = null;

interface FamilyRow {
  id: string;
  slug: string;
  status: string;
}

/** Open (or create) the registry. Idempotent — the CLI calls it too. */
export function initHosted(): void {
  if (registry) return;
  mkdirSync(familiesDir, { recursive: true });
  registry = openDatabase(join(env.dataDir, 'registry.db'));
  registry.exec(`
    CREATE TABLE IF NOT EXISTS families (
      id         TEXT PRIMARY KEY,
      slug       TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )
  `);

  // Every family catches up on schema at startup, exactly like a
  // single-family install does. A family that fails to migrate is logged
  // and skipped, not fatal: one broken database must not hold the other
  // families' breakfast hostage.
  let migrated = 0;
  for (const family of allFamilies()) {
    // A deleted family's files are gone; migrating it would quietly
    // recreate an empty hub.db in its place. Suspended families keep
    // migrating — they may come back mid-process, and must not return
    // to a schema the code has moved past.
    if (family.status === 'deleted') continue;
    try {
      runWithTenant(tenantFor(family.id), migrate);
      migrated += 1;
    } catch (err) {
      log.error(`family ${family.slug}: migration failed — skipped`, err);
    }
  }
  log.notice(`hosted mode: ${migrated} families on *.${env.hostedDomain}`);

  initHostedStats();
  setInterval(closeIdle, IDLE_SWEEP_MS).unref();
}

function allFamilies(): FamilyRow[] {
  return registry!.prepare('SELECT id, slug, status FROM families').all() as FamilyRow[];
}

// ── Slug → family ─────────────────────────────────────────────────────────

/**
 * The slug is the first DNS label under the hosted apex. Anything that
 * isn't exactly <one-label>.<apex> — the apex itself, a nested label, a
 * foreign host — resolves to nothing and ends up at the ghost.
 */
export function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const bare = host.split(':')[0]!.toLowerCase();
  const suffix = `.${env.hostedDomain}`;
  if (!bare.endsWith(suffix)) return null;
  const slug = bare.slice(0, -suffix.length);
  return /^[a-z0-9-]{1,63}$/.test(slug) ? slug : null;
}

/*
  Slug lookups are cached briefly. A registry read is microseconds, but
  this also bounds how often a suspended family keeps answering: within
  the TTL after a status flip, requests may still land in the old state —
  accepted, suspension is an operator action, not a security boundary.
*/
const SLUG_TTL_MS = 30_000;
const slugCache = new Map<string, { familyId: string | null; at: number }>();

function familyIdBySlug(slug: string): string | null {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.at < SLUG_TTL_MS) return cached.familyId;

  const row = registry!
    .prepare("SELECT id FROM families WHERE slug = ? AND status = 'active'")
    .get(slug) as { id: string } | undefined;
  const familyId = row?.id ?? null;

  // Negative entries are capped: unknown slugs arrive from the whole
  // internet and must not grow the cache without bound.
  if (familyId !== null || slugCache.size < 1000) {
    slugCache.set(slug, { familyId, at: Date.now() });
  }
  return familyId;
}

// ── Open tenants (LRU) ────────────────────────────────────────────────────

/*
  Open database handles are pooled and closed when idle. A handle is a
  few megabytes of page cache — fine for dozens of families, not for
  keeping every family ever seen open forever.

  Closing can in principle race a slow in-flight request (multipart
  upload, mail send): the eviction targets are least-recently-used and
  idle-for-half-an-hour handles, and lastUsed is stamped on every
  request, so a handle in flight is never the one chosen.
*/
const MAX_OPEN = 50;
const IDLE_CLOSE_MS = 30 * 60_000;
const IDLE_SWEEP_MS = 5 * 60_000;

interface OpenTenant {
  tenant: Tenant;
  lastUsed: number;
}

const openTenants = new Map<string, OpenTenant>();

function tenantFor(familyId: string): Tenant {
  const entry = openTenants.get(familyId);
  if (entry) {
    entry.lastUsed = Date.now();
    return entry.tenant;
  }

  if (openTenants.size >= MAX_OPEN) evictOldest();

  const dir = join(familiesDir, familyId);
  const attachmentsDir = join(dir, 'attachments');
  const backupsDir = join(dir, 'backups');
  mkdirSync(attachmentsDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  const tenant: Tenant = {
    db: openDatabase(join(dir, 'hub.db')),
    attachmentsDir,
    backupsDir,
    familyId,
  };
  openTenants.set(familyId, { tenant, lastUsed: Date.now() });
  return tenant;
}

function closeTenant(familyId: string): void {
  const entry = openTenants.get(familyId);
  if (!entry) return;
  openTenants.delete(familyId);
  try {
    // close() checkpoints the WAL — the family stays a single file on disk
    entry.tenant.db.close();
  } catch (err) {
    log.warn(`family ${familyId}: database failed to close`, err);
  }
}

function evictOldest(): void {
  let oldest: string | null = null;
  let oldestAt = Infinity;
  for (const [familyId, entry] of openTenants) {
    if (entry.lastUsed < oldestAt) {
      oldest = familyId;
      oldestAt = entry.lastUsed;
    }
  }
  if (oldest) closeTenant(oldest);
}

function closeIdle(): void {
  const cutoff = Date.now() - IDLE_CLOSE_MS;
  for (const [familyId, entry] of [...openTenants]) {
    if (entry.lastUsed < cutoff) closeTenant(familyId);
  }
}

// ── The ghost ─────────────────────────────────────────────────────────────

let ghost: Tenant | null = null;

function ghostTenant(): Tenant {
  if (!ghost) {
    const ghostDb = openDatabase(':memory:');
    runWithDb(ghostDb, migrate);
    // The ghost never stores a file (uploads sit behind auth, and the
    // ghost has no users), but its paths must still be real: code that
    // only reads them — the storage budget, for one — must not trip.
    const dir = join(familiesDir, '.ghost');
    mkdirSync(dir, { recursive: true });
    ghost = { db: ghostDb, attachmentsDir: dir, backupsDir: dir, ghost: true };
  }
  return ghost;
}

// ── Entry points ──────────────────────────────────────────────────────────

/** The tenant behind a Host header. Never null: unknown hosts get the ghost. */
export function resolveTenant(host: string | undefined): Tenant {
  const slug = slugFromHost(host);
  const familyId = slug === null ? null : familyIdBySlug(slug);
  return familyId === null ? ghostTenant() : tenantFor(familyId);
}

/**
 * The tenant behind a family slug, or null when no active family owns it.
 *
 * Deliberately unlike resolveTenant(): no ghost fallback. The ghost exists
 * so a browser cannot enumerate family names, but a caller that is not a
 * browser — the inbound mail webhook — must tell "no such family" apart
 * from "an empty hub", or it would silently ingest letters into a database
 * nobody ever reads.
 */
export function tenantForSlug(slug: string): Tenant | null {
  const familyId = familyIdBySlug(slug);
  return familyId === null ? null : tenantFor(familyId);
}

/**
 * Run a background job once per active family, sequentially — pollers
 * and sweeps written for one family work unchanged inside. One family's
 * failure is logged and does not stop the round.
 */
export async function forEachFamily(fn: () => unknown): Promise<void> {
  for (const family of allFamilies()) {
    if (family.status !== 'active') continue;
    try {
      await runWithTenant(tenantFor(family.id), async () => fn());
    } catch (err) {
      log.error(`family ${family.slug}: background job failed`, err);
    }
  }
}

/** Checkpoint and close everything on the way out. */
export function shutdownHosted(): void {
  shutdownHostedStats();
  for (const familyId of [...openTenants.keys()]) closeTenant(familyId);
  try {
    ghost?.db.close();
    registry?.close();
  } catch {
    // Already closed — not an error on exit
  }
}

// ── Provisioning (the CLI and, later, the control plane) ─────────────────

/**
 * Default slugs are <family name>-<4 random chars>, so collisions are
 * designed out; vanity renames come later and pass the same gate.
 * The reserved list keeps service names out of family hands: a family
 * called "mail" or "api" would collide with infrastructure sooner or
 * later, and "admin" or "billing" is a phishing costume.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'demo', 'mail', 'in', 'mx', 'smtp', 'imap', 'pop',
  'admin', 'billing', 'pay', 'account', 'accounts', 'login', 'auth',
  // Service senders: the hub writes from no-reply@<mail domain>, and a
  // family holding that name would receive other families' service mail
  'no-reply', 'noreply', 'postmaster', 'hello',
  'help', 'support', 'docs', 'blog', 'status', 'static', 'cdn', 'assets',
  'dev', 'staging', 'test', 'ns1', 'ns2', 'ftp', 'vpn', 'webmail',
]);

export function createFamily(slug: string): { familyId: string; url: string } {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Bad slug "${slug}": 3–30 chars of [a-z0-9-], letters or digits at the edges`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Slug "${slug}" is reserved for the service itself`);
  }

  const familyId = id();
  try {
    registry!
      .prepare('INSERT INTO families (id, slug, created_at) VALUES (?, ?, ?)')
      .run(familyId, slug, now());
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error(`Slug "${slug}" is already taken`);
    }
    throw err;
  }

  // Migrating right away turns "row in the registry" into "working hub":
  // the family's first visit gets the ordinary first-run screen and
  // creates its own admin — the same onboarding as a fresh install.
  runWithTenant(tenantFor(familyId), migrate);
  log.notice(`family created: ${slug} (${familyId})`);
  return { familyId, url: `https://${slug}.${env.hostedDomain}/` };
}

// ── Self-service deletion (GDPR, routes/family.ts) ───────────────────────

/** The family's slug — the phrase the admin must type to confirm deletion. */
export function familySlug(familyId: string): string | null {
  const row = registry!.prepare('SELECT slug FROM families WHERE id = ?').get(familyId) as
    | { slug: string }
    | undefined;
  return row?.slug ?? null;
}

/**
 * Remove a family's data for good: the database (all three WAL-mode
 * files) and the attachments directory.
 *
 * The order is the point. First the family becomes unroutable — registry
 * status plus the slug cache — and only then does the handle close and
 * the files go: reversed, a request landing between the steps would call
 * tenantFor, which recreates directories and an empty hub.db, and the
 * "deleted" family would resurrect as a blank hub on its old address.
 * Requests already in flight may hit a closed handle and fail with a
 * 500 — acceptable for an action this final.
 *
 * The row stays in the registry as status='deleted' rather than being
 * removed: the slug must never be re-registered by strangers (bookmarks
 * and mail addressed to it would land in their hands), and the control
 * plane reads the status to finish its own bookkeeping. Backups are
 * deliberately left alone — they are encrypted and expire within 14
 * days on their own, exactly as the privacy policy promises.
 */
export function deleteFamilyData(familyId: string): void {
  registry!.prepare(`UPDATE families SET status = 'deleted' WHERE id = ?`).run(familyId);
  for (const [slug, entry] of slugCache) {
    if (entry.familyId === familyId) slugCache.delete(slug);
  }
  closeTenant(familyId);

  const dir = join(familiesDir, familyId);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(dir, `hub.db${suffix}`), { force: true });
  }
  rmSync(join(dir, 'attachments'), { recursive: true, force: true });
  log.notice(`family deleted: ${familyId}`);
}

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { id, now, openDatabase, runWithDb, runWithTenant, type Tenant } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { env } from '../env.js';
import { initHostedStats, shutdownHostedStats } from './hosted-stats.js';
import { log } from './log.js';
import type { PlanRow } from './plan.js';

/*
  Hosted mode: many families on one server, routed by the Host header.

  family = subdomain = one SQLite file. The demo sandboxes proved the
  mechanism (a request wrapped in its own database via AsyncLocalStorage);
  this module replaces the mapping source: sandbox cookie → permanent
  family looked up by subdomain slug.

  The registry (registry.db next to the family folders) maps slug → family.
  A family's folder is named by its internal id, never the slug: renaming
  a slug is a registry update, the files don't move (renameFamily below). Like demo-stats.db,
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
  // The registry has no migrations (it is operations, not product), so a
  // new column is added in place when it is missing. renamed_at is the
  // one-shot rename's spent ticket: set once, never cleared.
  const columns = (registry.prepare('PRAGMA table_info(families)').all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!columns.includes('renamed_at')) {
    registry.exec('ALTER TABLE families ADD COLUMN renamed_at TEXT');
  }
  // The address a self-serve sign-up (#262) was made with: lets a repeat
  // sign-up re-issue the invitation instead of minting a second family,
  // and marks the family as one the reaper may remove if it is never
  // claimed. Operator-created families leave it NULL.
  if (!columns.includes('founder_email')) {
    registry.exec('ALTER TABLE families ADD COLUMN founder_email TEXT');
  }
  // Billing facts (#265, lib/plan.ts derives the state). The first time
  // these columns appear, every family already here predates billing —
  // it was created before the public launch and keeps the promise made to
  // it then: grandfathered, free, until a date the operator sets with
  // set-plan.mjs. Families created afterwards start on the trial clock.
  if (!columns.includes('plan')) {
    registry.exec(`
      ALTER TABLE families ADD COLUMN plan TEXT;
      ALTER TABLE families ADD COLUMN plan_until TEXT;
      ALTER TABLE families ADD COLUMN subscription_status TEXT;
      ALTER TABLE families ADD COLUMN paddle_customer_id TEXT;
      ALTER TABLE families ADD COLUMN paddle_subscription_id TEXT;
      UPDATE families SET plan = 'legacy_free' WHERE plan IS NULL;
    `);
  }
  // When a family was deleted (2026-09-14). Its slug stays out of reach for
  // a year from this stamp - long enough for the family to move its mail
  // address everywhere it gave it - then sweepRetiredSlugs frees it. Rows
  // deleted before the column existed start their year now.
  if (!columns.includes('deleted_at')) {
    registry.exec('ALTER TABLE families ADD COLUMN deleted_at TEXT');
  }
  registry.prepare("UPDATE families SET deleted_at = ? WHERE status = 'deleted' AND deleted_at IS NULL").run(now());
  // Every Paddle event exactly once: Paddle retries anything that did not
  // answer 200, and a replayed event must not move the state twice
  registry.exec(`
    CREATE TABLE IF NOT EXISTS billing_events (
      event_id    TEXT PRIMARY KEY,
      event_type  TEXT NOT NULL,
      family_id   TEXT,
      received_at TEXT NOT NULL
    )
  `);
  // Letters about the plan, sent once per family per occasion (#265)
  registry.exec(`
    CREATE TABLE IF NOT EXISTS plan_letters (
      family_id TEXT NOT NULL,
      kind      TEXT NOT NULL,
      sent_at   TEXT NOT NULL,
      PRIMARY KEY (family_id, kind)
    )
  `);
  // Slugs a family gave up by renaming. Same rule as a deleted family's
  // slug: out of reach for a year, because bookmarks, PWA icons and mail
  // addressed to the old name would land with whoever took it; after a
  // year that is the family's own lookout (decided 2026-09-14).
  registry.exec(`
    CREATE TABLE IF NOT EXISTS retired_slugs (
      slug       TEXT PRIMARY KEY,
      family_id  TEXT NOT NULL,
      retired_at TEXT NOT NULL
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
 * The tenant behind a family id — for the operator's tools, which hold an
 * id from the registry rather than a Host header. Opens (and creates) the
 * family's files like a request would.
 */
export function tenantForFamily(familyId: string): Tenant {
  return tenantFor(familyId);
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
 * designed out; the family's one self-service rename passes the same gate.
 * The reserved list keeps service names out of family hands: a family
 * called "mail" or "api" would collide with infrastructure sooner or
 * later, and "admin" or "billing" is a phishing costume.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'demo', 'mail', 'in', 'mx', 'smtp', 'imap', 'pop',
  'admin', 'billing', 'pay', 'account', 'accounts', 'login', 'auth',
  // Self-serve sign-up lives on signup.<apex> (#262); the rest read as it
  'signup', 'start', 'new', 'join',
  // Service senders: the hub writes from no-reply@<mail domain>, and a
  // family holding that name would receive other families' service mail
  'no-reply', 'noreply', 'postmaster', 'hello',
  'help', 'support', 'docs', 'blog', 'status', 'static', 'cdn', 'assets',
  'dev', 'staging', 'test', 'ns1', 'ns2', 'ftp', 'vpn', 'webmail',
]);

/** True when the slug has the right shape — the cheap, public half of the gate. */
export function isWellFormedSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** Shape and reserved-name checks, shared by creation and rename. */
function checkSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Bad slug "${slug}": 3–30 chars of [a-z0-9-], letters or digits at the edges`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Slug "${slug}" is reserved for the service itself`);
  }
  if (registry!.prepare('SELECT 1 FROM retired_slugs WHERE slug = ?').get(slug)) {
    // Told apart from a live collision only in the log: to the caller a
    // retired slug is simply taken
    throw new Error(`Slug "${slug}" is already taken`);
  }
}

export function createFamily(slug: string): { familyId: string; url: string } {
  checkSlug(slug);

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

// ── Self-serve sign-up (routes/signup.ts, lib/reaper.ts) ─────────────────

export function recordFounderEmail(familyId: string, email: string): void {
  registry!.prepare('UPDATE families SET founder_email = ? WHERE id = ?').run(email.trim().toLowerCase(), familyId);
}

/** The most recent active family signed up with this address, if any. */
export function pendingFamilyByFounderEmail(email: string): string | null {
  const row = registry!
    .prepare("SELECT id FROM families WHERE founder_email = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(email.trim().toLowerCase()) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Active sign-up families older than the cutoff — the reaper's candidates. */
export function signupFamiliesCreatedBefore(cutoff: string): FamilyRow[] {
  return registry!
    .prepare("SELECT id, slug, status FROM families WHERE founder_email IS NOT NULL AND status = 'active' AND created_at < ?")
    .all(cutoff) as FamilyRow[];
}

// ── Billing (routes/billing.ts, routes/family.ts, lib/plan.ts) ────────────

export function planRow(familyId: string): PlanRow | null {
  return (registry!
    .prepare(
      `SELECT created_at, plan, plan_until, subscription_status, paddle_customer_id, paddle_subscription_id
         FROM families WHERE id = ? AND status != 'deleted'`,
    )
    .get(familyId) as PlanRow | undefined) ?? null;
}

/** What Paddle last said about the family's subscription. */
export function recordSubscription(
  familyId: string,
  sub: { customerId: string; subscriptionId: string; status: string; periodEnd: string | null },
): void {
  registry!
    .prepare(
      `UPDATE families
          SET plan = 'paid', paddle_customer_id = ?, paddle_subscription_id = ?, subscription_status = ?,
              plan_until = COALESCE(?, plan_until)
        WHERE id = ?`,
    )
    .run(sub.customerId, sub.subscriptionId, sub.status, sub.periodEnd, familyId);
}

/** The operator's hand: grandfather a family (until NULL = for good), or put it back on trial. */
export function setPlan(familyId: string, plan: 'legacy_free' | 'trial', until: string | null): void {
  registry!
    .prepare(`UPDATE families SET plan = ?, plan_until = ?, subscription_status = NULL WHERE id = ?`)
    .run(plan, until, familyId);
}

/** True when the event is new; false when Paddle is retrying one we have. */
export function recordBillingEvent(eventId: string, eventType: string, familyId: string | null): boolean {
  try {
    registry!
      .prepare('INSERT INTO billing_events (event_id, event_type, family_id, received_at) VALUES (?, ?, ?, ?)')
      .run(eventId, eventType, familyId, now());
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
    throw err;
  }
}

/** True the first time; false when this letter already went out. */
export function recordPlanLetter(familyId: string, kind: string): boolean {
  try {
    registry!.prepare('INSERT INTO plan_letters (family_id, kind, sent_at) VALUES (?, ?, ?)').run(familyId, kind, now());
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
    throw err;
  }
}

/** Active families with their billing facts — the daily plan sweep's input. */
export function familiesWithPlans(): (FamilyRow & PlanRow)[] {
  return registry!
    .prepare(
      `SELECT id, slug, status, created_at, plan, plan_until, subscription_status, paddle_customer_id, paddle_subscription_id
         FROM families WHERE status = 'active'`,
    )
    .all() as (FamilyRow & PlanRow)[];
}

// ── Self-service rename (routes/family.ts) ───────────────────────────────

export interface FamilyAddress {
  slug: string;
  /** When the family spent its one rename, or null while it still has it. */
  renamedAt: string | null;
}

/** The family's registry address. Null for the ghost and unknown ids. */
export function familyAddress(familyId: string): FamilyAddress | null {
  const row = registry!
    .prepare('SELECT slug, renamed_at FROM families WHERE id = ?')
    .get(familyId) as { slug: string; renamed_at: string | null } | undefined;
  return row ? { slug: row.slug, renamedAt: row.renamed_at } : null;
}

/**
 * Move a family to a new slug — once.
 *
 * The default slug is <name>-<4 random chars>, chosen by the operator so
 * that collisions are designed out; the family never had a say. This is
 * their one chance to pick something they can say out loud. Exactly one,
 * because everything hangs off the slug: the subdomain (bookmarks, PWA
 * icons, every session cookie — they are host-only, so everyone signs in
 * again), the mail address <slug>@<mail domain>, calendar subscription
 * links. Once a family has lived at an address, the cost of moving it is
 * theirs to bear and ours to hear about; one move, early, keeps both
 * small. The 24-hour window is enforced by the route, which knows when
 * the family was set up; the registry only knows whether the ticket has
 * been spent.
 *
 * Files never move — the folder is named by the internal id — so the
 * rename is one registry transaction plus dropping two cache entries:
 * the old slug (must stop routing now, not in 30 s) and the new one (may
 * be cached as "unknown" from an earlier probe).
 */
export function renameFamily(familyId: string, newSlug: string): { url: string } {
  checkSlug(newSlug);
  const current = familyAddress(familyId);
  if (!current) throw new Error('No such family');
  if (current.renamedAt) throw new Error('The family has already been renamed once');
  if (current.slug === newSlug) throw new Error('That is already the family address');

  const move = registry!.transaction(() => {
    const at = now();
    const result = registry!
      .prepare(
        `UPDATE families SET slug = ?, renamed_at = ?
          WHERE id = ? AND status = 'active' AND renamed_at IS NULL`,
      )
      .run(newSlug, at, familyId);
    if (result.changes === 0) throw new Error('The family is not active, or has already been renamed');
    registry!
      .prepare('INSERT INTO retired_slugs (slug, family_id, retired_at) VALUES (?, ?, ?)')
      .run(current.slug, familyId, at);
  });
  try {
    move();
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error(`Slug "${newSlug}" is already taken`);
    }
    throw err;
  }

  slugCache.delete(current.slug);
  slugCache.delete(newSlug);
  log.notice(`family renamed: ${current.slug} → ${newSlug} (${familyId})`);
  return { url: `https://${newSlug}.${env.hostedDomain}/` };
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
 * removed: the slug stays out of strangers' reach for a year (bookmarks
 * and mail addressed to it would land in their hands; see
 * sweepRetiredSlugs and releaseSlug), and the control plane reads the
 * status to finish its own bookkeeping. The nightly
 * archives under DATA_DIR/backups are deliberately left alone — they are
 * encrypted and expire on their own, exactly as the privacy policy
 * promises. The family's own directory goes entirely, per-family backups/
 * included: a leftover families/<id>/ is a trap — anything that so much
 * as stats a hub.db in it (an operator's sqlite3, a script) brings back an
 * empty file, and the nightly backup then archives it as if the family
 * were alive (seen 2026-09-14).
 */
export function deleteFamilyData(familyId: string): void {
  // founder_email existed to re-issue an unclaimed sign-up's letter; a
  // deleted family will never need that, and an address is personal data
  // the row has no reason to keep for the year the slug is held
  registry!
    .prepare(`UPDATE families SET status = 'deleted', deleted_at = ?, founder_email = NULL WHERE id = ?`)
    .run(now(), familyId);
  for (const [slug, entry] of slugCache) {
    if (entry.familyId === familyId) slugCache.delete(slug);
  }
  closeTenant(familyId);

  rmSync(join(familiesDir, familyId), { recursive: true, force: true });
  log.notice(`family deleted: ${familyId}`);
}

// ── Retired slugs: a year out of reach, then free ────────────────────────

/** How long a deleted or renamed family's slug stays out of strangers' reach. */
export const SLUG_RETIREMENT_MS = 365 * 24 * 60 * 60_000;

/**
 * A retired slug's tombstone: the row keeps its history (billing events,
 * letters, the fact of the deletion) under a name no real slug can equal —
 * '~' is outside the slug alphabet — so the UNIQUE index lets the real
 * name be registered again.
 */
function tombstoneSlug(slug: string, familyId: string): string {
  return `~${slug}~${familyId.slice(0, 8)}`;
}

/**
 * Free a slug the registry is holding back — by the operator's hand, for a
 * family that comes back and wants its old name (the mail addressed to it
 * lands with the same people, so the reason for the hold does not apply).
 * Returns what was released, or null when the slug is not held at all.
 */
export function releaseSlug(slug: string): 'deleted-family' | 'renamed-away' | null {
  const dead = registry!
    .prepare("SELECT id FROM families WHERE slug = ? AND status = 'deleted'")
    .get(slug) as { id: string } | undefined;
  if (dead) {
    registry!.prepare('UPDATE families SET slug = ? WHERE id = ?').run(tombstoneSlug(slug, dead.id), dead.id);
    slugCache.delete(slug);
    log.notice(`slug released: ${slug} (deleted family ${dead.id})`);
    return 'deleted-family';
  }
  const retired = registry!.prepare('DELETE FROM retired_slugs WHERE slug = ?').run(slug);
  if (retired.changes > 0) {
    slugCache.delete(slug);
    log.notice(`slug released: ${slug} (retired by rename)`);
    return 'renamed-away';
  }
  return null;
}

/** Daily: slugs whose year of retirement is over become available again. Returns how many. */
export function sweepRetiredSlugs(nowMs = Date.now()): number {
  const cutoff = new Date(nowMs - SLUG_RETIREMENT_MS).toISOString().replace('T', ' ').slice(0, 19);
  let freed = 0;
  const dead = registry!
    .prepare("SELECT id, slug FROM families WHERE status = 'deleted' AND deleted_at < ? AND slug NOT LIKE '~%'")
    .all(cutoff) as { id: string; slug: string }[];
  for (const row of dead) {
    registry!.prepare('UPDATE families SET slug = ? WHERE id = ?').run(tombstoneSlug(row.slug, row.id), row.id);
    slugCache.delete(row.slug);
    freed += 1;
  }
  freed += registry!.prepare('DELETE FROM retired_slugs WHERE retired_at < ?').run(cutoff).changes;
  if (freed > 0) log.notice(`retired slugs: ${freed} freed after a year`);
  return freed;
}

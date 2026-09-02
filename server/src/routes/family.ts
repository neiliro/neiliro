import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { currentTenant, db } from '../db/index.js';
import { env } from '../env.js';
import { clearSessionCookie, consumeTotp, requireAdmin } from '../lib/auth.js';
import { verifyPassword } from '../lib/password.js';
import { log } from '../lib/log.js';

/*
  The family's data, self-service: the complete archive from Settings and
  the delete-everything button behind it. Both are promises the privacy
  policy already makes; until now they were concierge operations
  (scripts/export.mjs by hand, family:delete in the control plane).
  The family's address — its subdomain slug — lives here too: read-only,
  except for the one rename a fresh family is allowed (lib/tenants.ts).

  Everything here goes through the tenant context (db proxy,
  currentTenant()), never the static paths.* — in hosted mode the
  request's family is the only family this code may see.
*/

/**
 * The manifest's table inventory — the same list scripts/export.mjs
 * writes and scripts/import.mjs verifies row-by-row before swapping a
 * database in. Kept in sync by the round-trip test (family-export.test.ts),
 * which runs a settings export through the real import script.
 */
const EXPORT_TABLES = [
  'users',
  'projects',
  'tasks',
  'notes',
  'note_versions',
  'folders',
  'calendars',
  'events',
  'accounts',
  'categories',
  'transactions',
  'budgets',
  'recurring_transactions',
  'attachments',
  'settings',
];

function countRows(snapshot: Database.Database, table: string): number | null {
  try {
    return (snapshot.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null;
  }
}

function dirSize(dir: string): { files: number; bytes: number } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

const deleteInput = z.object({
  password: z.string().min(1).max(500),
  code: z.string().min(6).max(10).optional(),
  confirm: z.string().min(1).max(100),
});

const renameInput = z.object({
  slug: z.string().min(1).max(100),
});

/**
 * How long after first-run setup the family may still pick its address.
 *
 * Counted from setup, not from provisioning: the operator creates the
 * family when the invitation goes out, and the family may open the link
 * days later. Their day starts when their admin exists.
 */
const RENAME_WINDOW_MS = 24 * 60 * 60_000;

/** The moment the family's first account was created, as a Date — or null before setup. */
function setupAt(): Date | null {
  const row = db.prepare('SELECT min(created_at) AS at FROM users').get() as { at: string | null };
  if (!row.at) return null;
  // created_at is written by now() / datetime('now') — UTC without a zone marker
  const at = new Date(`${row.at.replace(' ', 'T')}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function registerFamilyRoutes(app: FastifyInstance): Promise<void> {
  /*
    The complete archive: the database via VACUUM INTO (the WAL journal
    is folded in — copying hub.db as a plain file would lose the freshest
    writes), every attachment, and a manifest. The layout matches
    scripts/export.mjs exactly, so the archive restores into a
    self-hosted hub through scripts/import.mjs — the no-lock-in promise.

    The rate limit is strict because this is the most expensive request
    in the app: VACUUM INTO rewrites the whole database and tar reads
    every attachment. Three per window is plenty for a human admin and
    starves a script.
  */
  app.get(
    '/api/family/export',
    { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (!requireAdmin(req, reply)) return;
      // demoBlocked passes every GET through, so the demo check lives on
      // the route: sandboxes are throwaways, an "archive" of one misleads.
      if (env.demoMode) {
        return reply.code(403).send({ error: 'Disabled in the demo' });
      }

      const { attachmentsDir } = currentTenant();
      const staging = mkdtempSync(join(tmpdir(), 'hub-export-'));
      const discard = () => rm(staging, { recursive: true, force: true }).catch(() => {});

      try {
        const snapshotPath = join(staging, 'hub.db');
        // Through the db proxy on purpose: in hosted mode this snapshots
        // the requesting family's database, never the default paths.db.
        db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

        // The manifest is read off the snapshot, not the live database:
        // the live one keeps moving, and import.mjs compares the counts
        // against the file that is actually inside the archive.
        const snapshot = new Database(snapshotPath, { readonly: true });
        const manifest = {
          exported_at: new Date().toISOString(),
          // scripts/export.mjs writes source_data_dir here; the settings
          // export deliberately doesn't — a hosted archive must not leak
          // server filesystem paths. import.mjs never reads the field.
          source: 'settings',
          migrations: snapshot
            .prepare('SELECT name FROM _migrations ORDER BY name')
            .all()
            .map((r) => (r as { name: string }).name),
          counts: Object.fromEntries(
            EXPORT_TABLES.map((table) => [table, countRows(snapshot, table)]),
          ),
          attachments: dirSize(attachmentsDir),
        };
        snapshot.close();
        writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      } catch (err) {
        await discard();
        throw err;
      }

      /*
        Streamed straight from tar's stdout — the archive never lands on
        disk as a whole, only the database snapshot does. Attachments are
        read from their live directory (basename is always 'attachments',
        both for the single family and for hosted tenants), which gives
        the exact top-level layout import.mjs expects: hub.db,
        manifest.json, attachments/.
      */
      const tar = spawn('tar', [
        '-czf',
        '-',
        '-C',
        staging,
        'hub.db',
        'manifest.json',
        '-C',
        dirname(attachmentsDir),
        basename(attachmentsDir),
      ]);
      let stderr = '';
      tar.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      tar.on('close', (exitCode) => {
        if (exitCode !== 0) log.error(`family export: tar exited ${exitCode}: ${stderr.trim()}`);
        void discard();
      });

      log.info(`family export started by ${req.user!.email}`);
      const stamp = new Date().toISOString().slice(0, 10);
      return reply
        .header('Content-Type', 'application/gzip')
        .header('Content-Disposition', `attachment; filename="neiliro-${stamp}.tar.gz"`)
        .send(tar.stdout);
    },
  );

  // ── The family's address (hosted only) ─────────────────────────────────

  const notHosted = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'The family address is managed by the hosted service only' });

  /*
    What the family is called on the wire and whether that can still
    change. The rename is a one-shot ticket that expires 24 hours after
    setup (see RENAME_WINDOW_MS); both halves are decided here so that the
    settings card and the first-sign-in offer read one answer.
  */
  app.get('/api/family/address', async (req, reply) => {
    if (!env.hostedMode) return notHosted(reply);
    if (!requireAdmin(req, reply)) return;
    const { familyId } = currentTenant();
    if (!familyId) return notHosted(reply);

    const { familyAddress } = await import('../lib/tenants.js');
    const address = familyAddress(familyId);
    if (!address) return notHosted(reply);

    const since = setupAt();
    const until = since ? new Date(since.getTime() + RENAME_WINDOW_MS) : null;
    const available = !address.renamedAt && until !== null && until.getTime() > Date.now();
    return {
      slug: address.slug,
      domain: env.hostedDomain,
      // The mail domain, so the card can spell out the address that moves
      // along — null where the service has no mail
      mail: env.mailDomain || null,
      rename: {
        available,
        // Only meaningful while the offer stands — the UI shows the deadline
        until: available ? until!.toISOString() : null,
        renamed: address.renamedAt !== null,
      },
    };
  });

  /*
    The one rename. Admin only, inside the window, once. The reply carries
    the new URL: the session cookie is host-only, so the browser is sent to
    the new address to sign in again — there is nothing to hand over.

    The rate limit is there because "not available" is, in principle, an
    oracle for which names exist. A fresh family's admin is the only one
    who can ask, and only for a day, but ten guesses an hour is all a
    person picking a name needs and far too slow for a census.
  */
  app.post(
    '/api/family/rename',
    { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req, reply) => {
      if (!env.hostedMode) return notHosted(reply);
      if (!requireAdmin(req, reply)) return;
      const { familyId } = currentTenant();
      if (!familyId) return notHosted(reply);

      const parsed = renameInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Check the fields' });
      }
      const slug = parsed.data.slug.trim().toLowerCase();

      const { familyAddress, isWellFormedSlug, renameFamily } = await import('../lib/tenants.js');
      const address = familyAddress(familyId);
      if (!address) return notHosted(reply);

      const since = setupAt();
      const open = since !== null && since.getTime() + RENAME_WINDOW_MS > Date.now();
      if (address.renamedAt || !open) {
        return reply.code(400).send({ error: 'The family address can no longer be changed' });
      }
      if (!isWellFormedSlug(slug)) {
        return reply.code(400).send({
          error: 'An address is 3–30 lowercase letters, digits and dashes, starting and ending with a letter or digit',
        });
      }
      if (slug === address.slug) {
        return reply.code(400).send({ error: 'That is already the family address' });
      }

      let url: string;
      try {
        ({ url } = renameFamily(familyId, slug));
      } catch (err) {
        // Reserved, taken and retired all read the same from outside: the
        // reasons differ only for the operator's log
        log.info(`family rename refused for ${address.slug}: ${(err as Error).message}`);
        return reply.code(409).send({ error: 'This address is not available' });
      }

      log.notice(`family renamed: ${address.slug} → ${slug} by ${req.user!.email}`);
      return { ok: true, url };
    },
  );

  /*
    Self-deletion — hosted only. A self-hosted install has exactly one
    family, so this button would mean "erase the whole instance"; the
    owner of the machine does that at the filesystem, not from a web
    form one misclick away from the only copy of the data. The GDPR
    promise this implements ("deleting your family removes its database
    and files") is about the hosted service.

    Three proofs are required, all server-side: the admin's password, a
    current TOTP code when the account has one, and the family's slug
    typed by hand. The rate limit is login-strength — a stolen session
    must not get free password guesses here.
  */
  app.post(
    '/api/family/delete',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (!env.hostedMode) {
        return reply.code(403).send({ error: 'Family deletion is available on the hosted service only' });
      }
      if (!requireAdmin(req, reply)) return;
      const { familyId } = currentTenant();
      if (!familyId) {
        // The ghost and anything else without a registry id has nothing
        // to delete; a real family always carries one.
        return reply.code(403).send({ error: 'Family deletion is available on the hosted service only' });
      }

      const parsed = deleteInput.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Check the fields' });
      }

      const user = db
        .prepare('SELECT password_hash, totp_secret, totp_confirmed_at FROM users WHERE id = ?')
        .get(req.user!.id) as {
        password_hash: string;
        totp_secret: string | null;
        totp_confirmed_at: string | null;
      };

      if (!(await verifyPassword(parsed.data.password, user.password_hash))) {
        return reply.code(400).send({ error: 'The current password is incorrect' });
      }
      if (user.totp_confirmed_at && user.totp_secret) {
        if (!parsed.data.code) {
          return reply.code(400).send({ error: 'Enter the code' });
        }
        if (!consumeTotp(req.user!.id, user.totp_secret, parsed.data.code)) {
          return reply.code(401).send({ error: 'Wrong code' });
        }
      }

      const { familySlug, deleteFamilyData } = await import('../lib/tenants.js');
      const slug = familySlug(familyId);
      if (!slug || parsed.data.confirm.trim().toLowerCase() !== slug) {
        return reply.code(400).send({ error: 'The confirmation phrase does not match the family address' });
      }

      log.notice(`family self-deletion: ${slug} (${familyId}) by ${req.user!.email}`);
      // Beyond this line the family's database is closed and gone —
      // nothing below may touch db, and the reply is assembled from
      // what was read above.
      deleteFamilyData(familyId);
      clearSessionCookie(reply);
      return { ok: true };
    },
  );
}

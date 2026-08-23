#!/usr/bin/env node
/**
 * Import data from an archive on a new device.
 *
 * Before swapping anything in, it verifies database integrity and that
 * the contents match the manifest. Existing data is never touched without
 * explicit permission: silently overwriting someone's database is the most
 * expensive surprise there is.
 *
 * Usage: npm run import -- path/to/neiliro-2026-08-03.tar.gz
 *        npm run import -- archive.tar.gz --force
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const force = args.includes('--force');
const archive = args.find((a) => !a.startsWith('--'));

if (!archive) {
  console.error('Provide an archive: npm run import -- path/to/neiliro-YYYY-MM-DD.tar.gz');
  process.exit(1);
}
if (!existsSync(archive)) {
  console.error(`No archive at: ${resolve(archive)}`);
  process.exit(1);
}

const dataDir = resolve(process.env.DATA_DIR ?? join(homedir(), '.family-hub'));
const existingDb = join(dataDir, 'hub.db');
const staging = mkdtempSync(join(tmpdir(), 'hub-import-'));

try {
  execFileSync('tar', ['-xzf', resolve(archive), '-C', staging], { stdio: 'inherit' });

  const incomingDb = join(staging, 'hub.db');
  if (!existsSync(incomingDb)) {
    console.error('No hub.db in the archive — this is not a hub export.');
    process.exit(1);
  }

  const manifest = existsSync(join(staging, 'manifest.json'))
    ? JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'))
    : null;

  // Verify before swapping in: better not to install a broken database at all
  const incoming = new Database(incomingDb, { readonly: true });
  const integrity = incoming.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    console.error(`The database in the archive is corrupted: ${integrity}`);
    process.exit(1);
  }

  const mismatches = [];
  if (manifest?.counts) {
    for (const [table, expected] of Object.entries(manifest.counts)) {
      if (expected === null) continue;
      try {
        const actual = incoming.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
        if (actual !== expected) mismatches.push(`${table}: manifest says ${expected}, database has ${actual}`);
      } catch {
        mismatches.push(`${table}: table missing`);
      }
    }
  }
  const applied = incoming
    .prepare('SELECT name FROM _migrations ORDER BY name')
    .all()
    .map((r) => r.name);
  incoming.close();

  if (mismatches.length > 0) {
    console.error('Contents do not match the manifest:');
    for (const line of mismatches) console.error(`  ${line}`);
    process.exit(1);
  }

  // Existing data
  const occupied = existsSync(existingDb);
  if (occupied && !force) {
    console.error('');
    console.error(`There is already a database in ${dataDir}.`);
    console.error('Importing will overwrite it. If that is what you want, add --force:');
    console.error(`  npm run import -- ${archive} --force`);
    console.error('');
    console.error('The previous database will be set aside, not deleted.');
    process.exit(1);
  }

  mkdirSync(dataDir, { recursive: true });

  if (occupied) {
    const backup = join(dataDir, `hub-before-import-${new Date().toISOString().slice(0, 10)}.db`);
    renameSync(existingDb, backup);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(existingDb + suffix)) rmSync(existingDb + suffix);
    }
    console.log(`Previous database set aside: ${backup}`);
  }

  cpSync(incomingDb, existingDb);

  const incomingAttachments = join(staging, 'attachments');
  if (existsSync(incomingAttachments)) {
    cpSync(incomingAttachments, join(dataDir, 'attachments'), { recursive: true });
  }
  mkdirSync(join(dataDir, 'backups'), { recursive: true });

  // Count files specifically: recursive also lists the per-month subdirectories
  const attachmentsDir = join(dataDir, 'attachments');
  const files = existsSync(attachmentsDir)
    ? readdirSync(attachmentsDir, { recursive: true, withFileTypes: true }).filter((e) =>
        e.isFile(),
      ).length
    : 0;

  console.log('');
  console.log(`Data imported into ${dataDir}`);
  console.log(`Migrations in the database: ${applied.length}, latest ${applied.at(-1) ?? '—'}`);
  if (manifest) {
    const rows = Object.entries(manifest.counts)
      .filter(([, n]) => n)
      .map(([table, n]) => `${table}: ${n}`);
    console.log(`Contents: ${rows.join(', ')}`);
    console.log(`Exported: ${manifest.exported_at}`);
  }
  console.log(`Attachment files on disk: ${files}`);
  console.log('');
  console.log('Next:');
  console.log('  1. npm run dev  — or docker compose up -d --build');
  console.log('  2. Passwords and accounts came along, no initial setup needed');
  console.log('  3. If HTTPS was set up: ./scripts/setup-https.sh — this device needs its own certificate');
  console.log('  4. sudo pmset repeat wakeorpoweron MTWRFSU 06:30:00');
} finally {
  rmSync(staging, { recursive: true, force: true });
}

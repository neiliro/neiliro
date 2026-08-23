#!/usr/bin/env node
/**
 * Export all data into one portable archive.
 *
 * hub.db can't be copied as a plain file: the database runs in WAL mode,
 * and fresh writes live in the sibling journal. So the database is opened
 * as a database and exported via VACUUM INTO — the output is one consistent
 * file, and it's safe even while the server is running.
 *
 * Usage: npm run export
 *        npm run export -- ~/Desktop
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = resolve(process.env.DATA_DIR ?? join(homedir(), '.family-hub'));
const outDir = resolve(process.argv[2] ?? process.cwd());
const dbPath = join(dataDir, 'hub.db');

if (!existsSync(dbPath)) {
  console.error(`No database at: ${dbPath}`);
  console.error('Check DATA_DIR or run the app at least once.');
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const archive = join(outDir, `neiliro-${stamp}.tar.gz`);
const staging = mkdtempSync(join(tmpdir(), 'hub-export-'));

function countRows(db, table) {
  try {
    return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } catch {
    return null;
  }
}

function dirSize(dir) {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return { files, bytes };
}

try {
  const source = new Database(dbPath, { readonly: true });

  // Consistent snapshot as a single file, the journal is folded in
  source.exec(`VACUUM INTO '${join(staging, 'hub.db').replace(/'/g, "''")}'`);

  const manifest = {
    exported_at: new Date().toISOString(),
    source_data_dir: dataDir,
    migrations: source
      .prepare('SELECT name FROM _migrations ORDER BY name')
      .all()
      .map((r) => r.name),
    counts: Object.fromEntries(
      [
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
      ].map((table) => [table, countRows(source, table)]),
    ),
  };
  source.close();

  const attachments = join(dataDir, 'attachments');
  if (existsSync(attachments)) {
    cpSync(attachments, join(staging, 'attachments'), { recursive: true });
  } else {
    mkdirSync(join(staging, 'attachments'), { recursive: true });
  }
  manifest.attachments = dirSize(join(staging, 'attachments'));

  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(outDir, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });

  const size = statSync(archive).size;
  const rows = Object.entries(manifest.counts)
    .filter(([, n]) => n)
    .map(([table, n]) => `${table}: ${n}`);

  console.log('');
  console.log(`Archive: ${archive}`);
  console.log(`Size: ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Attachments: ${manifest.attachments.files} totaling ${(manifest.attachments.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Contents: ${rows.join(', ')}`);
  console.log('');
  console.log('Everything is inside, including private notes and personal accounts.');
  console.log('Transfer via AirDrop or a cable, not email.');
  console.log('');
  console.log('On the new device: npm install && npm run import -- path/to/archive');
} finally {
  rmSync(staging, { recursive: true, force: true });
}

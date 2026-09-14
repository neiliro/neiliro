import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase, runWithDb } from './index.js';
import { migrate } from './migrate.js';

/*
  A smoke test of the whole schema: every migration must apply on an empty
  database with foreign_keys enabled. This used to be checked by hand
  before every schema change — now the run is part of CI.
*/

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const migrationFiles = (): string[] =>
  readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

/*
  Applying a single migration to a database that already holds data — the
  case an empty-database smoke test cannot reach, and the one that matters
  for a real hub being upgraded.

  Rather than re-implementing the runner (and drifting from how it wraps
  each file in a transaction), the target and everything after it are
  pre-recorded as applied so the real migrate() stops short; then the
  target's row is removed and migrate() runs again, applying exactly it.
  Pre-recording the tail as well keeps this correct when a 020 lands.
*/
function applyBefore(db: ReturnType<typeof openDatabase>, target: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const hold = db.prepare('INSERT INTO _migrations (name) VALUES (?)');
  for (const file of migrationFiles().filter((f) => f >= target)) hold.run(file);
  runWithDb(db, () => migrate());
}

function applyOnly(db: ReturnType<typeof openDatabase>, target: string): void {
  db.prepare('DELETE FROM _migrations WHERE name = ?').run(target);
  runWithDb(db, () => migrate());
}

describe('migrations', () => {
  it('all apply on an empty database and exactly once', () => {
    const db = openDatabase(':memory:');
    runWithDb(db, () => migrate());

    const applied = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as {
      name: string;
    }[];
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    expect(applied.map((r) => r.name)).toEqual(files);

    // A repeat run is idempotent: nothing re-applies and nothing crashes
    runWithDb(db, () => migrate());
    const again = db.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number };
    expect(again.n).toBe(files.length);
    db.close();
  });

  it('creates the key tables and the seeded rows', () => {
    const db = openDatabase(':memory:');
    runWithDb(db, () => migrate());

    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string;
      }[]).map((r) => r.name),
    );
    for (const table of [
      'users', 'sessions', 'invites',
      'projects', 'tasks', 'folders', 'notes', 'attachments',
      'calendars', 'events',
      'accounts', 'categories', 'transactions', 'budgets', 'recurring_transactions',
      'settings',
    ]) {
      expect(tables, `missing table ${table}`).toContain(table);
    }

    // Seeded entities with fixed ids — the client depends on them
    const inbox = db
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get('00000000-0000-4000-8000-000000000001');
    expect(inbox, 'missing the Inbox project').toBeTruthy();
    const shared = db
      .prepare('SELECT id FROM calendars WHERE id = ?')
      .get('00000000-0000-4000-8000-000000000201');
    expect(shared, 'missing the shared calendar').toBeTruthy();
    db.close();
  });

  /*
    019 drops attachments.task_id. Dropping a column rewrites the table, so
    the risk is not "does the statement parse" — it is what happens to the
    rows, the remaining foreign keys and the other indexes on a database
    that is already in use. An empty-database run proves none of that.
  */
  it('019 drops attachments.task_id without disturbing existing rows', () => {
    const db = openDatabase(':memory:');
    const TARGET = '019_drop_attachment_task_id.sql';
    applyBefore(db, TARGET);

    const columnsOf = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

    // Precondition: the column is there to be dropped, or this test proves nothing
    expect(columnsOf('attachments')).toContain('task_id');

    // A hub in use: a note with two files, one of them carrying the legacy
    // task_id — a real foreign key, so the row exercises the constraint the
    // table rewrite has to preserve
    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, status, priority, position)
       VALUES ('t1', ?, 0, 'Legacy task', 'todo', 'normal', 1)`,
    ).run(project.id);
    db.prepare(
      `INSERT INTO notes (id, title, body_md, created_at, updated_at)
       VALUES ('n1', 'Note', 'body', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path, note_id, task_id, created_at)
       VALUES ('a1', 'receipt.jpg', 'image/jpeg', 1234, '2026-01/x.jpg', 'n1', 't1', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path, note_id, created_at)
       VALUES ('a2', 'doc.pdf', 'application/pdf', 999, '2026-01/y.pdf', 'n1', '2026-01-01')`,
    ).run();

    const foreignKeysBefore = (
      db.prepare(`SELECT count(*) AS n FROM pragma_foreign_key_list('attachments')`).get() as {
        n: number;
      }
    ).n;

    applyOnly(db, TARGET);

    // The column and its index are gone
    expect(columnsOf('attachments')).not.toContain('task_id');
    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attachments'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).not.toContain('idx_attachments_task');

    // Everything else survived the rewrite: rows, their values, the other
    // indexes, the remaining foreign keys, and the task that was referenced
    expect(
      db.prepare('SELECT id, filename, note_id FROM attachments ORDER BY id').all(),
    ).toEqual([
      { id: 'a1', filename: 'receipt.jpg', note_id: 'n1' },
      { id: 'a2', filename: 'doc.pdf', note_id: 'n1' },
    ]);
    expect(indexes).toContain('idx_attachments_note');
    expect(indexes).toContain('idx_attachments_transaction');
    expect(
      (
        db.prepare(`SELECT count(*) AS n FROM pragma_foreign_key_list('attachments')`).get() as {
          n: number;
        }
      ).n,
    ).toBe(foreignKeysBefore - 1);
    expect(db.prepare(`SELECT id FROM tasks WHERE id = 't1'`).get()).toBeTruthy();

    // And the chain is complete — nothing was left pending by the two-step run
    expect(
      (db.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number }).n,
    ).toBe(migrationFiles().length);
    db.close();
  });

  /*
    039 drops the FTS5 search_index and its nine sync triggers (search
    moved to the browser, #226). The risk here is not the DROP statements
    themselves — it's whether removing an index that piggybacks on every
    notes/tasks/projects write leaves the tables it was triggered from
    untouched. An empty-database run can't exercise that: the triggers
    only fire, and the index only fills, once there is a row to insert.
  */
  it('039 drops search_index and its triggers without touching notes or tasks', () => {
    const db = openDatabase(':memory:');
    const TARGET = '039_drop_search_index.sql';
    applyBefore(db, TARGET);

    const project = db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string };
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, status, priority, position)
       VALUES ('t1', ?, 0, 'Legacy task', 'todo', 'normal', 1)`,
    ).run(project.id);
    db.prepare(
      `INSERT INTO notes (id, title, body_md, created_at, updated_at)
       VALUES ('n1', 'Note', 'body', '2026-01-01', '2026-01-01')`,
    ).run();

    // Precondition: the triggers actually populated the index, or dropping
    // it later proves nothing about a hub that had ever written anything
    const indexedBefore = (
      db.prepare('SELECT count(*) AS n FROM search_index').get() as { n: number }
    ).n;
    expect(indexedBefore).toBeGreaterThan(0);

    applyOnly(db, TARGET);

    // The table and every one of its nine triggers are gone
    const gone = (name: string) =>
      db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(name);
    expect(gone('search_index')).toBeUndefined();
    for (const trigger of [
      'notes_ai', 'notes_ad', 'notes_au',
      'tasks_ai', 'tasks_ad', 'tasks_au',
      'projects_ai', 'projects_ad', 'projects_au',
    ]) {
      expect(gone(trigger), `${trigger} should be gone`).toBeUndefined();
    }

    // The rows the (now-gone) triggers used to mirror are untouched
    expect(db.prepare(`SELECT id, title FROM notes WHERE id = 'n1'`).get()).toEqual({
      id: 'n1',
      title: 'Note',
    });
    expect(db.prepare(`SELECT id, title FROM tasks WHERE id = 't1'`).get()).toEqual({
      id: 't1',
      title: 'Legacy task',
    });

    // And the chain is complete — nothing was left pending by the two-step run
    expect(
      (db.prepare('SELECT count(*) AS n FROM _migrations').get() as { n: number }).n,
    ).toBe(migrationFiles().length);
    db.close();
  });

  /*
    022 renames settings keys and rescales amounts. Both are destructive
    edits to rows a family has typed into, so what matters is a database
    already in use: an untouched seed and a customized one behave
    differently on purpose.
  */
  const GOAL = '022_goal_widget.sql';

  const settingsOf = (db: ReturnType<typeof openDatabase>): Record<string, string> =>
    Object.fromEntries(
      (db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map(
        (r) => [r.key, r.value],
      ),
    );

  it('022 turns the move board into a goal, keeping what the family typed', () => {
    const db = openDatabase(':memory:');
    applyBefore(db, GOAL);

    const set = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    set.run('Moving to Belgrade', 'move.label');
    set.run('2026-09-01', 'move.target_date');
    set.run('Saved for the flat', 'savings.label');
    set.run('1250', 'savings.amount_eur');
    set.run('3000', 'savings.goal_eur');

    applyOnly(db, GOAL);
    const settings = settingsOf(db);

    expect(settings['goal.title']).toBe('Moving to Belgrade');
    expect(settings['goal.date']).toBe('2026-09-01');
    expect(settings['goal.saved_label']).toBe('Saved for the flat');
    // Whole euros become minor units, like every other amount here
    expect(settings['goal.saved']).toBe('125000');
    expect(settings['goal.target']).toBe('300000');
    // Empty: follow the default currency until told otherwise
    expect(settings['goal.currency']).toBe('');
    for (const gone of [
      'move.label',
      'move.target_date',
      'savings.label',
      'savings.amount_eur',
      'savings.goal_eur',
    ]) {
      expect(settings, `${gone} should be gone`).not.toHaveProperty(gone);
    }
    db.close();
  });

  it('022 rewords the untouched seed, which was about a move', () => {
    const db = openDatabase(':memory:');
    applyBefore(db, GOAL);
    applyOnly(db, GOAL);
    const settings = settingsOf(db);

    expect(settings['goal.title']).toBe('Goal');
    expect(settings['goal.date']).toBe('');
    expect(settings['goal.saved']).toBe('0');
    expect(settings['goal.target']).toBe('0');
    db.close();
  });
});

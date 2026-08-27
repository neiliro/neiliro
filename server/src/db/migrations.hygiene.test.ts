import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
  Repository hygiene, as tests, because these two mistakes both fail far
  from their cause.

  1. Duplicate files named "thing 2.ext". They appear when git restores
     untracked files over existing ones (a stash pop), and `git add -A`
     sweeps them into a commit. A stray copy of a migration took the whole
     suite down twice in two days with "table already exists" — a message
     that points at the migration runner rather than at the junk file.

  2. Two migrations claiming the same number. Nothing stops two branches
     from both writing 029_*.sql; they merge cleanly, and the second one to
     apply fails at runtime. That is a merge hazard, not a typo, and it
     grows with the number of branches in flight.
*/

const SERVER_SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_SRC = join(SERVER_SRC, '..', '..', 'web', 'src');
const MIGRATIONS = join(SERVER_SRC, 'db', 'migrations');

/** Every file under a directory, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe('repository hygiene', () => {
  it('found both source trees', () => {
    // Guards the walk: a wrong path would make the checks below vacuous
    expect(walk(SERVER_SRC).length).toBeGreaterThan(20);
    expect(walk(WEB_SRC).length).toBeGreaterThan(20);
  });

  it('has no "… 2" duplicate files', () => {
    /*
      The shape git leaves behind: "029_list_sections 2.sql",
      "lists.test 2.ts". A space, a small number, then the extension.
      Legitimate filenames in this project never look like that.
    */
    const strays = [...walk(SERVER_SRC), ...walk(WEB_SRC)]
      .filter((path) => / \d+\.[a-z]+$/.test(path))
      .map((path) => path.slice(path.lastIndexOf('/') + 1));

    expect(strays).toEqual([]);
  });

  it('gives every migration a unique number', () => {
    const numbers = new Map<string, string[]>();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      const prefix = file.slice(0, 3);
      numbers.set(prefix, [...(numbers.get(prefix) ?? []), file]);
    }
    // Two branches can each write 029_*.sql, merge without conflict, and
    // fail only when the second one runs
    const clashes = [...numbers.entries()].filter(([, files]) => files.length > 1);
    expect(clashes).toEqual([]);
  });

  it('creates each table in exactly one migration', () => {
    const created = new Map<string, string[]>();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/gi)) {
        const table = m[1]!;
        created.set(table, [...(created.get(table) ?? []), file]);
      }
    }
    // This is the assertion that would have caught the stray copy directly,
    // by name, instead of a SQLITE_ERROR halfway through an unrelated test
    const twice = [...created.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([table, files]) => `${table}: ${files.join(', ')}`);
    expect(twice).toEqual([]);
  });
});

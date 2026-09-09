import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLEAR_FIELDS, ENCRYPTED_FIELDS } from './field-map';

/*
  Every TEXT column of an encrypted table is accounted for: either sealed
  by the codec or listed as clear with a reason. The schema lives only in
  the migrations, so that is what is read — a column added by a future
  migration to one of these tables fails here until someone decides.
*/
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../server/src/db/migrations');

function textColumns(table: string): string[] {
  const columns = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const create = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (create) {
      for (const line of create[1]!.split('\n')) {
        const m = line.match(/^\s*([a-z_]+)\s+TEXT\b/);
        if (m) columns.add(m[1]!);
      }
    }
    for (const m of sql.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN ([a-z_]+) TEXT\\b`, 'g'))) {
      columns.add(m[1]!);
    }
    // A column dropped later (attachments.task_id, migration 019) is not a column
    for (const m of sql.matchAll(new RegExp(`ALTER TABLE ${table} DROP COLUMN ([a-z_]+)`, 'g'))) {
      columns.delete(m[1]!);
    }
  }
  return [...columns].sort();
}

describe('the field map covers the schema', () => {
  for (const table of Object.keys(ENCRYPTED_FIELDS)) {
    it(`accounts for every TEXT column of ${table}`, () => {
      const columns = textColumns(table);
      expect(columns.length).toBeGreaterThan(0);
      const accounted = [...ENCRYPTED_FIELDS[table]!, ...Object.keys(CLEAR_FIELDS[table] ?? {})].sort();
      expect(columns).toEqual(accounted.filter((c) => columns.includes(c)));
      const unaccounted = columns.filter((c) => !accounted.includes(c));
      expect(unaccounted).toEqual([]);
    });
  }

  it('never lists a column as both encrypted and clear', () => {
    for (const [table, sealed] of Object.entries(ENCRYPTED_FIELDS)) {
      for (const column of sealed) expect(CLEAR_FIELDS[table]?.[column]).toBeUndefined();
    }
  });
});

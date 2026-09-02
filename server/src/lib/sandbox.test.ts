import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db/index.js';
import { env } from '../env.js';
import { createSandbox, destroySandbox, initDemo, shutdownDemo } from './sandbox.js';
import { DEMO_LANGS, demoStrings } from './demo.strings.js';

/*
  The seeder is covered on its own; what this covers is the join between it
  and the sandbox — that a template exists per language, and that a visitor
  is handed the one matching theirs. Getting that wrong is invisible in the
  seeder's own tests and shows up as an English demo for Russian visitors.
*/
describe('demo sandboxes', () => {
  const created: string[] = [];

  afterAll(() => {
    for (const id of created) destroySandbox(id, 'shutdown');
    shutdownDemo();
  });

  it('builds a template for every language and hands out the right one', async () => {
    await initDemo();

    for (const lang of DEMO_LANGS) {
      expect(
        existsSync(join(env.dataDir, 'demo', `template.${lang}.db`)),
        `no template for ${lang}`,
      ).toBe(true);
    }

    for (const lang of DEMO_LANGS) {
      const sandbox = createSandbox({}, lang);
      created.push(sandbox.id);
      expect(sandbox.lang).toBe(lang);

      // Read the copy from disk rather than the open handle: this is the
      // file the visitor's requests will actually be served from
      const db = openDatabase(sandbox.file);
      try {
        const S = demoStrings(lang);
        const titles = (db.prepare('SELECT title FROM tasks').all() as { title: string }[]).map(
          (r) => r.title,
        );
        expect(titles, `${lang} sandbox has the wrong language`).toContain(S.tasks.repaint);

        const categories = (
          db.prepare('SELECT name FROM categories').all() as { name: string }[]
        ).map((r) => r.name);
        expect(categories).toContain(S.money.categories.groceries);
      } finally {
        db.close();
      }
    }
  });

  it('falls back to English when no language is asked for', () => {
    const sandbox = createSandbox({});
    created.push(sandbox.id);
    expect(sandbox.lang).toBe('en');
  });
});

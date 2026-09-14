import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../db/index.js';
import { env } from '../env.js';
import { createSandbox, destroySandbox, initDemo, shutdownDemo } from './sandbox.js';
import { DEMO_LANGS, demoStrings } from './demo.strings.js';
import { isCiphertext } from './ciphertext.js';
import { FieldOpener } from './envelope.js';

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
        // The copy holds ciphertext under the guest's key (#225) — which is
        // exactly what the browser receives from /api/keys, so open it the
        // way the browser would
        const opener = new FieldOpener(Buffer.from(sandbox.guestKey, 'base64url'));
        const tasks = db.prepare('SELECT id, title FROM tasks').all() as { id: string; title: string }[];
        expect(tasks.every((t) => isCiphertext(t.title)), `${lang} sandbox left titles in the clear`).toBe(true);
        const titles = await Promise.all(
          tasks.map((t) => opener.open(t.title, { table: 'tasks', column: 'title', id: t.id })),
        );
        expect(titles, `${lang} sandbox has the wrong language`).toContain(S.tasks.repaint);

        const rows = db.prepare('SELECT id, name FROM categories').all() as { id: string; name: string }[];
        const categories = await Promise.all(
          rows.map((r) => opener.open(r.name, { table: 'categories', column: 'name', id: r.id })),
        );
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

import { describe, expect, it } from 'vitest';
import { openDatabase, runWithDb, today } from '../db/index.js';
import { shiftDays } from './dates.js';
import { migrate } from '../db/migrate.js';
import { seedDemo } from './demo.js';
import { DEMO_LANGS, demoStrings } from './demo.strings.js';

/*
  The demo seeder runs at sandbox-template build, which means a broken
  INSERT crashes the whole demo server at startup — and that is exactly
  how a missing NULL in a multi-row VALUES list was actually found. The
  seeder must be exercised where CI can see it, not on the live stand.
*/
describe('seedDemo', () => {
  it('seeds an empty database without crashing, profiles included', async () => {
    const db = openDatabase(':memory:');
    runWithDb(db, () => migrate());
    await runWithDb(db, () => seedDemo('en'));

    const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
    expect(n('SELECT count(*) AS n FROM users')).toBeGreaterThan(0);
    expect(n('SELECT count(*) AS n FROM profiles')).toBe(2);
    expect(n(`SELECT count(*) AS n FROM profile_entries WHERE kind = 'allergy'`)).toBe(1);
    expect(n('SELECT count(*) AS n FROM wishes')).toBe(4);
    // One wish arrives pre-claimed by a guest, to showcase the public link
    expect(n('SELECT count(*) AS n FROM wishes WHERE claimed_by_name IS NOT NULL')).toBe(1);
    // The derived birthday events carry the back-reference the routes use
    expect(n('SELECT count(*) AS n FROM events WHERE profile_user_id IS NOT NULL')).toBe(2);

    /*
      The balance widget's showcase, and the reason these dates are
      relative: a visitor must always find a bill already due — the one
      the widget lets them tick off — and money arriving later, rather
      than months of pay days nobody ever confirmed.
    */
    const rules = db
      .prepare(
        `SELECT title, kind, start_on, auto_create FROM recurring_transactions WHERE active = 1`,
      )
      .all() as { title: string; kind: string; start_on: string; auto_create: number }[];
    const dueNow = rules.filter(
      (r) =>
        r.kind === 'expense' &&
        r.auto_create === 0 &&
        r.start_on <= today() &&
        r.start_on >= shiftDays(today(), -7),
    );
    expect(dueNow.length, 'no bill a visitor could confirm').toBeGreaterThan(0);
    const income = rules.find((r) => r.kind === 'income');
    expect(income && income.start_on > today(), 'the next pay day is not ahead').toBe(true);

    /*
      The month view is the widest thing a visitor can open, and it reads
      as an empty grid unless the seeds reach past the two weeks around
      today. Recurring anchors count: they expand forward from wherever
      they start, so an anchor three weeks back fills the earlier rows.
    */
    const events = db
      .prepare('SELECT starts_at, recurrence_rule FROM events')
      .all() as { starts_at: string; recurrence_rule: string | null }[];
    const earlier = events.filter((e) => e.starts_at.slice(0, 10) < shiftDays(today(), -7));
    const later = events.filter((e) => e.starts_at.slice(0, 10) > shiftDays(today(), 14));
    expect(earlier.length, 'nothing in the weeks before today').toBeGreaterThan(0);
    expect(later.length, 'nothing in the weeks after today').toBeGreaterThan(0);
    expect(
      events.filter((e) => e.recurrence_rule?.includes('WEEKLY')).length,
      'no weekly rhythm to fill the month',
    ).toBeGreaterThan(1);

    // Idempotence: a second run on a non-empty database is a no-op
    await runWithDb(db, () => seedDemo('en'));
    expect(n('SELECT count(*) AS n FROM profiles')).toBe(2);
    db.close();
  });

  /*
    Every language goes through the same statements with a different table
    of strings, so a mismatched parameter count is a language-specific
    crash — and the demo server dies at startup building that template.
    Cheaper to find here. The shapes are compared against each other as
    well as against a literal: a language that silently seeds fewer rows
    is a thinner demo for those visitors, and nothing else would say so.
  */
  it('seeds every language to the same shape', async () => {
    const shapes: Record<string, Record<string, number>> = {};

    for (const lang of DEMO_LANGS) {
      const db = openDatabase(':memory:');
      runWithDb(db, () => migrate());
      await runWithDb(db, () => seedDemo(lang));

      const n = (q: string) => (db.prepare(q).get() as { n: number }).n;
      shapes[lang] = {
        users: n('SELECT count(*) AS n FROM users'),
        tasks: n('SELECT count(*) AS n FROM tasks'),
        notes: n('SELECT count(*) AS n FROM notes'),
        events: n('SELECT count(*) AS n FROM events'),
        mail: n('SELECT count(*) AS n FROM mail_messages'),
        wishes: n('SELECT count(*) AS n FROM wishes'),
        transactions: n('SELECT count(*) AS n FROM transactions'),
        recurring: n('SELECT count(*) AS n FROM recurring_transactions'),
      };

      const S = demoStrings(lang);

      // The nesting used to be a second statement matching task titles in
      // English; it is set by id now, and this is what says it still works
      const children = db
        .prepare('SELECT title FROM tasks WHERE parent_id = (SELECT id FROM tasks WHERE title = ?)')
        .all(S.tasks.repaint) as { title: string }[];
      expect(children.map((c) => c.title).sort(), `${lang}: subtasks are not nested`).toEqual(
        [S.tasks.pickColour, S.tasks.buyPaint.title].sort(),
      );

      // The shopping list links to a task by title, so in this language the
      // link has to name a task that actually exists
      const body = (
        db.prepare('SELECT body_md FROM notes WHERE title = ?').get(S.notes.shopping.title) as {
          body_md: string;
        }
      ).body_md;
      const linked = /\[\[(.+?)\]\]/.exec(body)?.[1];
      expect(linked, `${lang}: no wiki-link in the shopping list`).toBe(S.tasks.repaint);
      expect(
        (db.prepare('SELECT count(*) AS n FROM tasks WHERE title = ?').get(linked) as { n: number })
          .n,
        `${lang}: the wiki-link points at no task`,
      ).toBe(1);

      db.close();
    }

    expect(shapes.en).toEqual({
      users: 2, tasks: 8, notes: 5, events: 13, mail: 2,
      wishes: 4, transactions: 6, recurring: 4,
    });
    for (const lang of DEMO_LANGS) expect(shapes[lang], `${lang} differs`).toEqual(shapes.en);
  });
});

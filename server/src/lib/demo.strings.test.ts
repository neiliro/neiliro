import { describe, expect, it } from 'vitest';
import { DEMO_LANGS, demoStrings, isDemoLang } from './demo.strings.js';

/*
  A missing string is a compile error (every table is typed as DemoStrings),
  so what is left to check is the other failure: a string that was copied
  across instead of translated. Nothing catches that but a comparison, and
  a half-Russian demo reads worse than an honestly English one.
*/

/** Every leaf of the table, as path → text. Functions are called with a marker. */
function leaves(table: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (typeof value === 'function') {
      out.set(path, (value as (arg: string) => string)('«marker»'));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of leaves(value, path)) out.set(k, v);
    }
  }
  return out;
}

/*
  Strings that are the same in every language on purpose: given names that
  read naturally in both, and real brands. Anything else matching English
  is an untranslated string, and the test says which one.
*/
const SHARED = new Set([
  'users.alex',
  'users.sam',
  'money.places.lidl',
  'money.places.pizzeria',
  'events.gym.location',
  'events.carService.location',
]);

describe('demo strings', () => {
  it('offers English and at least one other language', () => {
    expect(DEMO_LANGS).toContain('en');
    expect(DEMO_LANGS.length).toBeGreaterThan(1);
  });

  it('recognises its own languages and nothing else', () => {
    expect(isDemoLang('ru')).toBe(true);
    expect(isDemoLang('de')).toBe(false);
    expect(isDemoLang(null)).toBe(false);
    expect(isDemoLang(42)).toBe(false);
  });

  const english = leaves(demoStrings('en'));

  for (const lang of DEMO_LANGS.filter((l) => l !== 'en')) {
    describe(lang, () => {
      const other = leaves(demoStrings(lang));

      it('has the same shape as English', () => {
        expect([...other.keys()].sort()).toEqual([...english.keys()].sort());
      });

      it('leaves no string untranslated', () => {
        const copied = [...english]
          .filter(([path, text]) => !SHARED.has(path) && other.get(path) === text)
          .map(([path]) => path);
        expect(copied, 'these read as English in a non-English demo').toEqual([]);
      });

      it('keeps the wiki-link pointing at the task it names', () => {
        // notes.shopping.body embeds tasks.repaint in [[...]]; translate one
        // and not the other and the demo ships a link to nothing
        const body = demoStrings(lang).notes.shopping.body(demoStrings(lang).tasks.repaint);
        expect(body).toContain(`[[${demoStrings(lang).tasks.repaint}]]`);
      });
    });
  }
});

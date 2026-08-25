import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ru, ruPlurals } from './i18n.ru';

/*
  Every user-visible string has to exist in the Russian dictionary.

  An unknown key passes through unchanged by design — a missing
  translation shows English rather than crashing, which is the right
  behaviour at runtime and the reason nothing ever reports it. The PWA
  update toast shipped untranslated for a whole release that way.

  So the check belongs here rather than in anyone's attention: walk the
  source, collect the string literals handed to t() and plural(), and
  compare against the dictionary.

  Only literals can be checked. t(someVariable) is invisible to a
  reader of the source and is skipped — the alternative would be a
  linter rule forbidding it, which is a heavier trade than it is worth.
*/

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    // Test files are excluded on purpose: they use deliberately unknown
    // keys as fixtures for the pass-through behaviour
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

const sources = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

/** `t('…')` and `t("…")`, with escaped quotes inside the literal allowed. */
const T_CALL = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

/** `plural(n, 'day', 'days')` — the singular is the key into the plural table. */
const PLURAL_CALL = /\bplural\(\s*[^,]+,\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'/g;

function collect(re: RegExp, group: number): Map<string, string> {
  const found = new Map<string, string>();
  for (const { path, text } of sources) {
    for (const m of text.matchAll(re)) {
      const key = m[group];
      if (key && !found.has(key)) found.set(key, path.slice(SRC.length + 1));
    }
  }
  return found;
}

/*
  The server answers in English and the client translates by exact match,
  so a reworded server message stops being translated without anything
  failing. That makes the server's error strings part of this dictionary's
  contract, which is why this test reaches across the workspace.
*/
const SERVER = join(SRC, '..', '..', 'server', 'src');
const ERROR_LITERAL = /error:\s*'((?:[^'\\]|\\.)*)'/g;

function serverErrorStrings(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of ['routes', 'lib']) {
    for (const path of sourceFiles(join(SERVER, dir))) {
      // The inbound mail webhook answers Mailgun, not a browser: its
      // strings are a delivery protocol (the status codes carry the
      // meaning) and no person ever reads them, so they are not part of
      // the dictionary's contract.
      if (path.endsWith('mail-inbound.ts')) continue;
      const text = readFileSync(path, 'utf8');
      for (const m of text.matchAll(ERROR_LITERAL)) {
        const message = m[1];
        // Interpolated messages are assembled at runtime and cannot be
        // matched as a whole; the client shows them untranslated by design
        if (message && !message.includes('${') && !found.has(message)) {
          found.set(message, path.slice(SERVER.length + 1));
        }
      }
    }
  }
  return found;
}

describe('Russian dictionary', () => {
  it('covers every t() literal in the source', () => {
    const keys = collect(T_CALL, 1);
    for (const [key, path] of collect(T_CALL, 2)) if (!keys.has(key)) keys.set(key, path);

    const missing = [...keys].filter(([key]) => !(key in ru));
    expect(keys.size).toBeGreaterThan(400); // the scan found the source at all
    expect(missing.map(([key, path]) => `${path}: ${key}`)).toEqual([]);
  });

  it('covers every error string the server can answer with', () => {
    const messages = serverErrorStrings();
    const missing = [...messages].filter(([message]) => !(message in ru));
    expect(messages.size).toBeGreaterThan(50);
    expect(missing.map(([message, path]) => `${path}: ${message}`)).toEqual([]);
  });

  it('covers every plural form used in the source', () => {
    const forms = collect(PLURAL_CALL, 1);
    const missing = [...forms].filter(([singular]) => !(singular in ruPlurals));
    expect(missing.map(([singular, path]) => `${path}: ${singular}`)).toEqual([]);
  });
});

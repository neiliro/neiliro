import { ru, ruPlurals } from './i18n.ru';

/*
  Internationalization. Approach: English strings are the dictionary keys.

  Code keeps t('Save'); the Russian dictionary (i18n.ru.ts) supplies the
  translation, English is the identity. What this buys:

  — the English locale is complete by construction, no dictionary needed;
  — a key missing from a dictionary is visible (shows up in English)
    but breaks nothing;
  — server errors are translated by the same t() in one place (lib/api.ts):
    the server sends English text, the client shows it in the UI language;
  — a new language is one dictionary file away (see i18n.ru.ts).

  Language is a device setting (localStorage), not an account one: a
  phone and a shared kiosk may speak different languages. A device that
  has never chosen takes the browser's own preference — until it did,
  every visitor met an English hub and had to find the switch, which on
  the public demo meant most of them never saw their own language at all.
  Switching languages reloads the page: it is a one-off action, and the
  reload removes the need for reactive plumbing — t() stays a pure
  function, usable outside React too.
*/

export type Lang = 'en' | 'ru';

const STORAGE_KEY = 'hub-lang';

const LANGS: readonly Lang[] = ['en', 'ru'];

/**
 * The browser's preference, narrowed to a language the hub speaks.
 *
 * navigator.languages is the ordered list the person actually configured;
 * the first entry the hub can speak wins, so someone who asked for German
 * and then Russian gets Russian rather than the English default. Region
 * subtags are ignored: ru-BY and ru are the same dictionary.
 */
function detectLang(): Lang {
  try {
    const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const tag of preferred) {
      const base = String(tag).toLowerCase().split('-')[0];
      const match = LANGS.find((l) => l === base);
      if (match) return match;
    }
  } catch {
    // No navigator at all (Node, tests) — English, as before
  }
  return 'en';
}

function readLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Only an explicit choice counts as stored: anything else, including
    // the absence of a value, falls through to what the browser prefers
    if (stored === 'ru' || stored === 'en') return stored;
  } catch {
    // Private mode without localStorage — fall through and detect
  }
  return detectLang();
}

export const lang: Lang = readLang();

// Document attributes follow the chosen language. index.html statically
// declares English (the default); here it is corrected to the actual one:
// lang for screen readers must match the UI language; the tab title is
// the brand and is not localized.
// The document check is because the module is also imported in Node (tests).
if (typeof document !== 'undefined') {
  document.documentElement.lang = lang;
  document.title = 'Neiliro';
}

export function setLang(next: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private mode without localStorage — the language just won't stick
  }
  window.location.reload();
}

/** Translate a string. Substitutions: {name} from params. */
export function t(key: string, params?: Record<string, string | number>): string {
  let out = lang === 'en' ? key : (ru[key] ?? key);
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

/**
 * Pluralization. Forms are given as the English pair (day/days) —
 * the singular doubles as the key into a language's plural table
 * (Russian needs three forms, see ruPlurals).
 */
export function tPlural(n: number, forms: [string, string]): string {
  if (lang === 'ru') {
    const triple = ruPlurals[forms[0]];
    if (!triple) return n === 1 ? (ru[forms[0]] ?? forms[0]) : (ru[forms[1]] ?? forms[1]);
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return triple[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return triple[1];
    return triple[2];
  }
  return n === 1 ? forms[0] : forms[1];
}

/** Locale for Intl date and number formatters. */
export const intlLocale = lang === 'ru' ? 'ru-RU' : 'en-GB';

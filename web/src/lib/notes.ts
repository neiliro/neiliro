import { familyTimezone } from './timezone';
import { today } from './tasks';

/*
  What the server used to do with a note's text and cannot any more (#215):
  the list preview, the [[link]] extraction, the template placeholders. The
  functions are the server's, moved — server/src/routes/notes.ts keeps its
  copies for plaintext rows from before the module was encrypted, and the
  two must agree, which notes.test.ts pins with the same fixtures.
*/

/** The one-line preview: markdown syntax stripped, text kept, 120 characters. */
export function excerptOf(body: string): string {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const WIKI_LINK = /\[\[([^\][|]{1,200})\]\]/g;
const ESCAPED_WIKI_LINK = /\\\[\\\[([^\][|]{1,200})\\\]\\\]/g;

/** Markdown editors escape square brackets; links are stored in canonical form. */
export function normalizeWikiLinks(body: string): string {
  return body.replace(ESCAPED_WIKI_LINK, '[[$1]]');
}

export function extractLinks(body: string): string[] {
  const titles = new Set<string>();
  for (const match of body.matchAll(WIKI_LINK)) {
    const title = match[1]?.trim();
    if (title) titles.add(title);
  }
  return [...titles];
}

function resolveLocale(locale: string | undefined): string {
  if (!locale) return 'en-GB';
  try {
    new Intl.DateTimeFormat(locale);
    return locale;
  } catch {
    return 'en-GB';
  }
}

/**
 * Template placeholders, expanded once at creation in the family's time
 * zone. The Russian keys stay for templates written before English-first.
 */
export function applyPlaceholders(text: string, authorName: string, locale?: string): string {
  const date = new Date();
  const tag = resolveLocale(locale);
  const timeZone = familyTimezone() || undefined;
  const longDate = new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone }).format(date);
  const shortTime = new Intl.DateTimeFormat(tag, { timeStyle: 'short', timeZone }).format(date);
  const values: Record<string, string> = {
    дата: longDate,
    date: longDate,
    изо: today(),
    iso: today(),
    время: shortTime,
    time: shortTime,
    автор: authorName,
    author: authorName,
  };
  return text.replace(/\{\{\s*([\wа-яёА-ЯЁ_]+)\s*\}\}/gu, (match, rawKey: string) => values[rawKey.toLowerCase()] ?? match);
}

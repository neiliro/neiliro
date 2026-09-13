import { randomInt } from 'node:crypto';

/*
  The default address of a family: its name spelled in [a-z0-9-], then four
  random characters — "Петровы" becomes petrovy-k3x9. The suffix is what
  makes collisions a non-event and a family's subdomain unguessable from
  its name (the ghost in tenants.ts relies on that). Validation of the
  result — length, charset, reserved names, uniqueness — stays in
  createFamily; this module only spells.

  It lived in the operator's script (neiliro-cloud/scripts/new-family.mjs)
  while families were created by hand; self-serve sign-up (#262) needs the
  same spelling on the server, so the script now imports it from here.
*/

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

// Room for "-xxxx" inside the 30-character cap
const BASE_MAX = 25;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The name as slug material, or '' when nothing of it survives. */
export function slugBase(name: string): string {
  // Cyrillic is spelled first, then NFKD splits accented Latin letters from
  // their marks so "Müller" becomes muller rather than mller. The order
  // matters: NFKD would take ё and й apart too, and е-with-a-mark spells
  // "e" where a Russian speaker expects "yo".
  const latin = [...name.toLowerCase()].map((ch) => TRANSLIT[ch] ?? ch).join('').normalize('NFKD');
  return latin
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, BASE_MAX)
    .replace(/-$/, '');
}

export function slugSuffix(): string {
  return Array.from({ length: 4 }, () => SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)]).join('');
}

/**
 * A fresh default slug for the family name. A name that leaves fewer than
 * two usable characters (an emoji, a script with no transliteration) gets
 * the neutral base "family" rather than a refusal: on the sign-up form
 * there is nobody to ask for a different spelling, and the family renames
 * itself once anyway.
 */
export function defaultSlug(name: string): string {
  const base = slugBase(name);
  return `${base.length >= 2 ? base : 'family'}-${slugSuffix()}`;
}

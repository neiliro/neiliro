/*
  The one thing the server knows about an encrypted value (ADR 0001): its
  prefix. `e1:` marks a field envelope sealed in the browser; anything else
  is plaintext from before the module was encrypted. The server never opens
  an envelope — this predicate exists so it can skip work that needs the
  words (excerpts, link extraction, copying a title into a new row) and
  leave it to the browser.
*/
const FIELD_PREFIX = 'e1:';
/** Sealed by the server itself to the family public key (#223, lib/envelope.ts). */
const SEALED_PREFIX = 's1:';

export const isCiphertext = (value: string | null | undefined): boolean =>
  typeof value === 'string' && (value.startsWith(FIELD_PREFIX) || value.startsWith(SEALED_PREFIX));

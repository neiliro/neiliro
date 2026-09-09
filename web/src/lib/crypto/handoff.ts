import { randomBytes, toBase64url, fromBase64url } from './encoding';
import { expandSecret, importWrapKey } from './kdf';

/*
  Handing the family key to another browser (ADR 0001, #210 and #212).

  One member wraps the key under a wrap key derived from a fresh random
  secret; the wrapped envelope goes to the server, the secret goes into the
  fragment of a link (`#k=…`), which browsers never send with a request.
  Whoever opens the link holds both halves and nothing on the server ever
  held the second. Two doors use it: re-admitting a member whose envelope
  died with a password reset, and (#212) giving an invited member the key.

  The secret is 32 random bytes — full entropy, so HKDF straight to the
  wrap key, no stretching, the same shape as the recovery code.
*/
const HANDOFF_INFO = 'neiliro/handoff/v1';
export const HANDOFF_PARAM = 'k';

export function newHandoffSecret(): string {
  return toBase64url(randomBytes(32));
}

export async function handoffWrapKey(secret: string): Promise<CryptoKey> {
  const bytes = fromBase64url(secret);
  if (bytes.length !== 32) throw new Error('Not a handoff secret');
  return importWrapKey(await expandSecret(bytes, HANDOFF_INFO));
}

/** The secret from a link's fragment, or null when the link lost it. */
export function handoffSecretFromFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const secret = params.get(HANDOFF_PARAM);
  return secret && /^[A-Za-z0-9_-]{43}$/.test(secret) ? secret : null;
}

export function fragmentFor(secret: string): string {
  return `#${HANDOFF_PARAM}=${secret}`;
}

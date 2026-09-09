/*
  The wrap key for the life of the tab (#211 → #210).

  Sign-in derives it alongside the auth key; the key envelope (#210) is
  opened with it right after. It is never persisted — the family key is
  what the key store keeps between loads, and a reload that finds no
  family key asks for the password again, which derives a fresh wrap key.
  A module variable rather than React state: nothing renders from it.
*/
let wrapKey: CryptoKey | null = null;

export function rememberWrapKey(key: CryptoKey): void {
  wrapKey = key;
}

export function currentWrapKey(): CryptoKey | null {
  return wrapKey;
}

export function forgetWrapKey(): void {
  wrapKey = null;
}

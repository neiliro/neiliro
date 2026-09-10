import { exportFamilyKey, toBase64url } from './crypto';
import { vaultKey, vaultReady } from './vault';

/*
  The two links that feed other people's software — the calendar
  subscription and the shared event — carry the family key after the token
  (`<token>~<key>`, #218). The server holds the token; the key half exists
  only in the link, appended here on the device that holds it, so the same
  token shown on a locked device is a link that opens nothing.

  This is a deliberate, disclosed hand-over: whoever pastes the link into
  Google Calendar is giving Google those events, and the server opens them
  for that request only (server/src/lib/envelope.ts).
*/
export async function familyKeySuffix(): Promise<string> {
<<<<<<< HEAD
  await vaultReady();
  const key = vaultKey();
=======
  return suffixForKey(vaultKey());
}

/**
 * The same, for a key a component already holds from the provider. A
 * component's effect runs before the provider's, so at the moment the key
 * appears `vaultKey()` may still be null — read the context's key instead
 * (#251).
 */
export async function suffixForKey(key: CryptoKey | null): Promise<string> {
>>>>>>> origin/master
  if (!key) return '';
  return `~${toBase64url(await exportFamilyKey(key))}`;
}

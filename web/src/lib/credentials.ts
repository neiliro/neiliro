import { api } from './api';
import { deriveCredentialKeys, newKdfSalt, rememberWrapKey, saltFromHex } from './crypto';
import { t } from './i18n';

/*
  The browser's side of the sign-in split (ADR 0001, #211). The server
  never sees a password again — it sees the auth key derived from it. The
  wrap key from the same derivation is kept for the tab (crypto/session.ts)
  so the key envelope can be opened without asking twice.

  The one exception is an account from before the split: the server
  still holds a hash of the password itself and needs it once more to
  verify, after which it stores the auth key's hash. /api/auth/prelogin
  says which kind an address is, and hands out the account's salt;
  unknown addresses read as migrated and get a decoy salt.
*/

/** The server's minimum, checked here now that the server cannot see the length. */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH ? t('Password must be at least 10 characters') : null;
}

export interface Prelogin {
  kdf: 'legacy' | 'v1';
  salt: string;
}

export const prelogin = (email: string): Promise<Prelogin> => api.post<Prelogin>('/auth/prelogin', { email });

/** Derive for a known salt; remembers the wrap key for the tab. */
export async function deriveWith(password: string, salt: string): Promise<string> {
  const keys = await deriveCredentialKeys(password, saltFromHex(salt));
  rememberWrapKey(keys.wrapKey);
  return keys.authKey;
}

/** For creating an account: a fresh salt and the key derived with it. */
export async function newCredentials(password: string): Promise<{ auth_key: string; kdf_salt: string }> {
  const kdf_salt = newKdfSalt();
  return { auth_key: await deriveWith(password, kdf_salt), kdf_salt };
}

export interface LoginBody {
  email: string;
  auth_key: string;
  password?: string;
}

/** What /api/auth/login expects for this address and password. */
export async function loginBody(email: string, password: string): Promise<LoginBody> {
  const { kdf, salt } = await prelogin(email);
  const auth_key = await deriveWith(password, salt);
  return kdf === 'legacy' ? { email, auth_key, password } : { email, auth_key };
}

import { concat, fromBase64url, toBase64url, type Bytes } from './encoding';
import { exportFamilyKey } from './envelope';

/*
  The family's X25519 pair (ADR 0001, #210), used from #223 on: the server
  holds the public half and seals incoming mail to it; only a browser
  holding the family key can open what was sealed.

  The private half is not a second secret to store. It is derived from the
  family key with HKDF under its own info string, so the one envelope per
  member keeps protecting everything, and there is nothing to re-wrap when
  the pair is first needed. The derivation is versioned in the info string:
  a different curve some day means a different string, not a guess.

  WebCrypto imports an X25519 private key only in PKCS#8, so the 32 derived
  bytes are wrapped in the fixed PKCS#8 header for that algorithm (RFC 8410).
*/
const X25519_INFO = 'neiliro/x25519/v1';

// SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 }, OCTET STRING { OCTET STRING <32 bytes> } }
const PKCS8_X25519_PREFIX = fromBase64url('MC4CAQAwBQYDK2VuBCIEIA');

async function privateSeed(familyKey: CryptoKey): Promise<Bytes> {
  const raw = await exportFamilyKey(familyKey);
  const hkdf = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(X25519_INFO) },
    hkdf,
    256,
  );
  raw.fill(0);
  return new Uint8Array(bits);
}

/** The family's X25519 private key, derived on demand and never stored. */
export async function familyPrivateKey(familyKey: CryptoKey): Promise<CryptoKey> {
  const seed = await privateSeed(familyKey);
  const pkcs8 = concat(PKCS8_X25519_PREFIX, seed);
  seed.fill(0);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
}

/** The public half, base64url of 32 bytes — what the server stores. */
export async function familyPublicKey(familyKey: CryptoKey): Promise<string> {
  const priv = await familyPrivateKey(familyKey);
  // The JWK of an X25519 private key carries its public point as `x`
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  if (!jwk.x) throw new Error('X25519 export without a public point');
  return jwk.x;
}

export const publicKeyBytes = (publicKey: string): Bytes => fromBase64url(publicKey);
export const publicKeyString = (bytes: Bytes): string => toBase64url(bytes);

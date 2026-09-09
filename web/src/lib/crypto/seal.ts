import { concat, fromBase64url, fromUtf8, randomBytes, toBase64url, utf8, type Bytes } from './encoding';
import { decryptFile, encryptFile } from './files';
import { fieldAad, type FieldPlace } from './envelope';
import { familyPrivateKey, familyPublicKey } from './x25519';

/*
  Sealing to the family's public key (ADR 0001, #223).

  Incoming mail reaches the server in the clear — a webhook or an IMAP
  poll hands it plaintext MIME — and the server has no family key to
  encrypt it with. What it has is the family's X25519 public half
  (family_key.public_key), so it seals what it received to that, once,
  before anything is written: an ephemeral X25519 pair, a shared secret
  with the family's public key, HKDF, AES-256-GCM. Only a browser that
  can derive the private half from the family key opens the result.

    s1:<ephemeral public key>:<nonce>:<ciphertext>      a field
    "NS1" || ephemeral public key (32) || NE1 file      a file

  The AES key is HKDF-SHA256(shared, salt = ephemeral || family, info
  "neiliro/seal/v1"). Binding both public keys into the salt means a
  ciphertext cannot be re-addressed to another family's key. Field AAD
  and file chunking are the same as for the family-key formats, so a
  sealed value is bound to its row and a sealed file to its id exactly as
  an ordinary one is.

  The server implements the sealing side of this in
  server/src/lib/envelope.ts; the two must agree byte for byte, and
  seal.test.ts pins the construction from this side.
*/

export const SEALED_PREFIX = 's1:';
const SEALED_FILE_MAGIC = utf8('NS1');
const SEAL_INFO = 'neiliro/seal/v1';

export const isSealed = (value: string | null | undefined): boolean =>
  typeof value === 'string' && value.startsWith(SEALED_PREFIX);

async function deriveSealKey(shared: Bytes, ephemeralPub: Bytes, familyPub: Bytes): Promise<CryptoKey> {
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(ephemeralPub, familyPub), info: utf8(SEAL_INFO) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The sealing side — what the server does; here for tests and symmetry. */
async function sealKeyFor(familyPub: Bytes): Promise<{ ephemeralPub: Bytes; key: CryptoKey }> {
  const ephemeral = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const recipient = await crypto.subtle.importKey('raw', familyPub, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: recipient }, ephemeral.privateKey, 256));
  const ephemeralPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  return { ephemeralPub, key: await deriveSealKey(shared, ephemeralPub, familyPub) };
}

/** The opening side — the browser, holding the family key. */
async function openKeyFor(familyKey: CryptoKey, ephemeralPub: Bytes): Promise<CryptoKey> {
  const priv = await familyPrivateKey(familyKey);
  const familyPub = fromBase64url(await familyPublicKey(familyKey));
  const sender = await crypto.subtle.importKey('raw', ephemeralPub, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: sender }, priv, 256));
  return deriveSealKey(shared, ephemeralPub, familyPub);
}

export async function sealField(familyPublicKeyB64: string, plaintext: string, place: FieldPlace): Promise<string> {
  const { ephemeralPub, key } = await sealKeyFor(fromBase64url(familyPublicKeyB64));
  const nonce = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: fieldAad(place) }, key, utf8(plaintext));
  return `${SEALED_PREFIX}${toBase64url(ephemeralPub)}:${toBase64url(nonce)}:${toBase64url(new Uint8Array(ct))}`;
}

export class SealError extends Error {}

export async function openSealedField(familyKey: CryptoKey, value: string, place: FieldPlace): Promise<string> {
  if (!value.startsWith(SEALED_PREFIX)) throw new SealError('Not a sealed field');
  const parts = value.slice(SEALED_PREFIX.length).split(':');
  if (parts.length !== 3) throw new SealError('Malformed sealed field');
  const ephemeralPub = fromBase64url(parts[0]!);
  if (ephemeralPub.length !== 32) throw new SealError('Malformed sealed field');
  const key = await openKeyFor(familyKey, ephemeralPub);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64url(parts[1]!), additionalData: fieldAad(place) },
      key,
      fromBase64url(parts[2]!),
    );
    return fromUtf8(new Uint8Array(pt));
  } catch {
    throw new SealError('Cannot open this value here');
  }
}

export async function sealFile(familyPublicKeyB64: string, plain: Bytes, fileId: string): Promise<Bytes> {
  const { ephemeralPub, key } = await sealKeyFor(fromBase64url(familyPublicKeyB64));
  return concat(SEALED_FILE_MAGIC, ephemeralPub, await encryptFile(key, plain, fileId));
}

export const isSealedFile = (bytes: Bytes): boolean =>
  bytes.length >= 35 && bytes[0] === SEALED_FILE_MAGIC[0] && bytes[1] === SEALED_FILE_MAGIC[1] && bytes[2] === SEALED_FILE_MAGIC[2];

export async function openSealedFile(familyKey: CryptoKey, sealed: Bytes, fileId: string): Promise<Bytes> {
  if (!isSealedFile(sealed)) throw new SealError('Not a sealed file');
  const key = await openKeyFor(familyKey, sealed.subarray(3, 35));
  return decryptFile(key, sealed.subarray(35), fileId);
}

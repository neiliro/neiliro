import { expandSecret, importWrapKey } from './kdf';
import { randomBytes, type Bytes } from './encoding';

/*
  The recovery code (#210): the door that stays open when every password
  is gone. 128 bits of randomness shown once as 26 letters and digits,
  grouped for reading aloud over the phone to the other parent:

    K7QX-3M9D-PRV2-H8TC-WJ5N-6B4F-AZ

  Alphabet without 0/O, 1/I/L and U (Crockford's base32, minus U): a code
  written on paper and typed back a year later must not fail on a letter
  that looks like a digit. Input is normalised — case, dashes and spaces
  do not matter, and the four look-alikes are mapped back.

  The code has full entropy, so unlike a password it needs no stretching:
  HKDF expands it straight into a wrap key, with its own info string so a
  code and a password can never produce the same key.
*/

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BITS = 128;
const CODE_CHARS = Math.ceil(CODE_BITS / 5); // 26
const RECOVERY_INFO = 'neiliro/recovery-wrap/v1';

export class RecoveryCodeError extends Error {}

export function generateRecoveryCode(): string {
  const bytes = randomBytes(16);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  // Left-align 128 bits in 130 so the last symbol carries two zero bits
  bits <<= 2n;
  let out = '';
  for (let i = CODE_CHARS - 1; i >= 0; i--) {
    out = ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)]! + out;
  }
  return format(out);
}

export function format(raw: string): string {
  return raw.match(/.{1,4}/g)!.join('-');
}

/** Case, separators and look-alike letters are the user's problem no more. */
export function normalizeRecoveryCode(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (cleaned.length !== CODE_CHARS || [...cleaned].some((c) => !ALPHABET.includes(c))) {
    throw new RecoveryCodeError('That does not look like a recovery code');
  }
  return cleaned;
}

function codeBytes(normalized: string): Bytes {
  let bits = 0n;
  for (const c of normalized) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(c));
  bits >>= 2n; // drop the two padding bits
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

export async function recoveryWrapKey(code: string): Promise<CryptoKey> {
  const material = await expandSecret(codeBytes(normalizeRecoveryCode(code)), RECOVERY_INFO);
  return importWrapKey(material);
}

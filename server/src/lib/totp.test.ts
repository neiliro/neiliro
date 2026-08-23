import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, totpStep } from './totp.js';

// RFC 6238 appendix B vectors use the ASCII secret "12345678901234567890";
// its base32 form:
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('base32', () => {
  it('round-trips', () => {
    const buf = Buffer.from('The quick brown fox');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('matches the RFC 4648 test vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('totp against RFC 6238 vectors', () => {
  // Appendix B lists 8-digit codes; ours are the standard 6, i.e. the
  // last six digits of the listed values.
  const vectors: [number, string][] = [
    [59, '287082'], // 94287082
    [1111111109, '081804'], // 07081804
    [1111111111, '050471'], // 14050471
    [1234567890, '005924'], // 89005924
    [2000000000, '279037'], // 69279037
  ];

  for (const [seconds, expected] of vectors) {
    it(`T=${seconds} → ${expected}`, () => {
      expect(totpStep(RFC_SECRET, expected, seconds * 1000)).toBe(Math.floor(seconds / 30));
    });
  }

  it('rejects a wrong code and malformed input', () => {
    expect(totpStep(RFC_SECRET, '000000', 59_000)).toBeNull();
    expect(totpStep(RFC_SECRET, '28708', 59_000)).toBeNull();
    expect(totpStep(RFC_SECRET, 'abcdef', 59_000)).toBeNull();
  });

  it('accepts one step of clock drift, not two', () => {
    const t = 1111111109 * 1000;
    const step = Math.floor(1111111109 / 30);
    expect(totpStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), t)).toBe(step - 1);
    expect(totpStep(RFC_SECRET, hotp(RFC_SECRET, step - 2), t)).toBeNull();
  });

  it('reports which step matched, so the caller can burn it', () => {
    const t = 1111111109 * 1000;
    const step = Math.floor(1111111109 / 30);
    expect(totpStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), t)).toBe(step + 1);
  });
});

describe('otpauthUri', () => {
  it('encodes the account and issuer', () => {
    const uri = otpauthUri('denis@hub.local', 'ABC234');
    expect(uri).toContain('otpauth://totp/Neiliro:denis%40hub.local');
    expect(uri).toContain('secret=ABC234');
    expect(uri).toContain('issuer=Neiliro');
  });
});

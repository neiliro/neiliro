import { describe, expect, it } from 'vitest';
import {
  KeyStore,
  MemoryBackend,
  decryptField,
  decryptFile,
  deriveCredentialKeys,
  encryptField,
  encryptFile,
  exportFamilyKey,
  fromBase64url,
  generateFamilyKey,
  generateRecoveryCode,
  importFamilyKey,
  isEncrypted,
  normalizeLogin,
  normalizeRecoveryCode,
  readField,
  recoveryWrapKey,
  toBase64url,
  unwrapFamilyKey,
  wrapFamilyKey,
} from './index';

/*
  Node 24 ships WebCrypto as globalThis.crypto, so the module runs here
  exactly as in a browser. The KDF vectors are the contract with the
  server twin (server/src/lib/kdf.ts, #211): same password and address
  must give the same authKey on both sides, or nobody can sign in.
*/

// Fast KDF for tests that do not test the KDF itself
const FAST = 1_000;

describe('kdf', () => {
  it('pins the auth key for a known password and address (the server twin checks the same vector)', async () => {
    const a = await deriveCredentialKeys('correct horse battery', 'Sam@Example.test ', FAST);
    const b = await deriveCredentialKeys('correct horse battery', 'sam@example.test', FAST);
    expect(a.authKey).toBe(b.authKey);
    expect(a.kdfVersion).toBe(1);
    expect(fromBase64url(a.authKey)).toHaveLength(32);
    // Frozen: a change here locks every existing account out
    expect(a.authKey).toBe('G5OP10cR6TUCBFrXL08VLqOGRCxufqPK7SpWGzrou7M');
  });

  it('pins the production vector at the real iteration count', async () => {
    // ~1 s on purpose: this is the exact string a browser sends for this
    // password, and the server twin must compute the very same one.
    const k = await deriveCredentialKeys('correct horse battery', 'sam@example.test');
    expect(k.authKey).toBe('gQWlfqTKxEE23jsPihnHil8499MP-gW40evaIaWZBn8');
  }, 30_000);

  it('produces different keys for a different address or password', async () => {
    const base = await deriveCredentialKeys('correct horse battery', 'sam@example.test', FAST);
    const other = await deriveCredentialKeys('correct horse battery', 'dana@example.test', FAST);
    const wrong = await deriveCredentialKeys('correct horse batteru', 'sam@example.test', FAST);
    expect(other.authKey).not.toBe(base.authKey);
    expect(wrong.authKey).not.toBe(base.authKey);
  });

  it('keeps the wrap key non-extractable and separate from the auth key', async () => {
    const k = await deriveCredentialKeys('correct horse battery', 'sam@example.test', FAST);
    expect(k.wrapKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', k.wrapKey)).rejects.toThrow();
  });

  it('normalises the login the way the server does', () => {
    expect(normalizeLogin('  Sam@Example.TEST ')).toBe('sam@example.test');
  });
});

describe('field envelope', () => {
  const place = { table: 'notes', column: 'body_md', id: 'n1' };

  it('round-trips and marks the value as encrypted', async () => {
    const key = await generateFamilyKey();
    const sealed = await encryptField(key, 'Молоко, хлеб, и 🥚', place);
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed.startsWith('e1:')).toBe(true);
    expect(await decryptField(key, sealed, place)).toBe('Молоко, хлеб, и 🥚');
  });

  it('never reuses a nonce', async () => {
    const key = await generateFamilyKey();
    const a = await encryptField(key, 'same', place);
    const b = await encryptField(key, 'same', place);
    expect(a).not.toBe(b);
  });

  it('refuses a value moved to another row, column or table', async () => {
    const key = await generateFamilyKey();
    const sealed = await encryptField(key, 'secret', place);
    await expect(decryptField(key, sealed, { ...place, id: 'n2' })).rejects.toThrow(/Cannot decrypt/);
    await expect(decryptField(key, sealed, { ...place, column: 'title' })).rejects.toThrow(/Cannot decrypt/);
    await expect(decryptField(key, sealed, { ...place, table: 'tasks' })).rejects.toThrow(/Cannot decrypt/);
  });

  it('refuses a tampered byte and another family key', async () => {
    const key = await generateFamilyKey();
    const sealed = await encryptField(key, 'secret', place);
    const [p, nonce, ct] = sealed.split(':') as [string, string, string];
    const bytes = fromBase64url(ct);
    bytes[0] = bytes[0]! ^ 1;
    await expect(decryptField(key, `${p}:${nonce}:${toBase64url(bytes)}`, place)).rejects.toThrow();
    await expect(decryptField(await generateFamilyKey(), sealed, place)).rejects.toThrow();
  });

  it('passes legacy plaintext through and keeps null', async () => {
    const key = await generateFamilyKey();
    expect(await readField(key, 'plain old title', place)).toBe('plain old title');
    expect(await readField(key, null, place)).toBeNull();
    const sealed = await encryptField(key, 'new', place);
    expect(await readField(key, sealed, place)).toBe('new');
  });

  it('fails loudly on an unknown version or a malformed envelope', async () => {
    const key = await generateFamilyKey();
    await expect(decryptField(key, 'e2:abc:def', place)).rejects.toThrow(/Not an encrypted/);
    await expect(decryptField(key, 'e1:onlyonepart', place)).rejects.toThrow(/Malformed/);
  });
});

describe('family key and envelopes', () => {
  it('wraps for a member and unwraps with the same password, not another', async () => {
    const family = await generateFamilyKey();
    const sam = await deriveCredentialKeys('correct horse battery', 'sam@example.test', FAST);
    const dana = await deriveCredentialKeys('another long password', 'dana@example.test', FAST);
    const env = await wrapFamilyKey(family, sam.wrapKey, { kind: 'password', owner: 'u-sam' });
    expect(env.startsWith('w1:')).toBe(true);

    const opened = await unwrapFamilyKey(env, sam.wrapKey, { kind: 'password', owner: 'u-sam' });
    expect(await exportFamilyKey(opened)).toEqual(await exportFamilyKey(family));
    // The unwrapped key must itself be wrappable (invites, re-admission)
    expect(opened.extractable).toBe(true);
    await expect(wrapFamilyKey(opened, dana.wrapKey, { kind: 'password', owner: 'u-dana' })).resolves.toMatch(/^w1:/);

    await expect(unwrapFamilyKey(env, dana.wrapKey, { kind: 'password', owner: 'u-sam' })).rejects.toThrow(
      /does not open/,
    );
    // Re-labelled as someone else's envelope: refused
    await expect(unwrapFamilyKey(env, sam.wrapKey, { kind: 'password', owner: 'u-dana' })).rejects.toThrow();
  });

  it('a wrapped key is not a field and a field is not a wrapped key', async () => {
    const family = await generateFamilyKey();
    const sam = await deriveCredentialKeys('correct horse battery', 'sam@example.test', FAST);
    const env = await wrapFamilyKey(family, sam.wrapKey, { kind: 'password', owner: 'u' });
    expect(isEncrypted(env)).toBe(false);
    await expect(unwrapFamilyKey('e1:a:b', sam.wrapKey, { kind: 'password', owner: 'u' })).rejects.toThrow(
      /Not a key envelope/,
    );
  });

  it('imports only 32-byte keys', async () => {
    await expect(importFamilyKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    const raw = await exportFamilyKey(await generateFamilyKey());
    expect(await exportFamilyKey(await importFamilyKey(raw))).toEqual(raw);
  });
});

describe('recovery code', () => {
  it('looks like 26 grouped symbols from the unambiguous alphabet', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('forgives case, separators and look-alike letters', () => {
    const code = generateRecoveryCode();
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    expect(normalizeRecoveryCode(sloppy)).toBe(code.replace(/-/g, ''));
    expect(() => normalizeRecoveryCode('too short')).toThrow(/does not look like/);
    expect(() => normalizeRecoveryCode(code.replace(/-/g, '') + 'A')).toThrow();
  });

  it('opens the envelope it wrapped, and no other code does', async () => {
    const family = await generateFamilyKey();
    const code = generateRecoveryCode();
    const env = await wrapFamilyKey(family, await recoveryWrapKey(code), { kind: 'recovery', owner: 'family' });
    const back = await unwrapFamilyKey(env, await recoveryWrapKey(code.toLowerCase()), {
      kind: 'recovery',
      owner: 'family',
    });
    expect(await exportFamilyKey(back)).toEqual(await exportFamilyKey(family));
    await expect(
      unwrapFamilyKey(env, await recoveryWrapKey(generateRecoveryCode()), { kind: 'recovery', owner: 'family' }),
    ).rejects.toThrow();
  });
});

describe('file envelope', () => {
  const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) & 0xff);

  it('round-trips empty, one-chunk, exact-multiple and ragged files', async () => {
    const key = await generateFamilyKey();
    for (const n of [0, 1, 1000, 2048, 2049, 5000]) {
      const plain = bytes(n);
      const sealed = await encryptFile(key, plain, 'f1', 1024);
      expect(sealed.length).toBe(15 + Math.max(1, Math.ceil(n / 1024)) * 16 + n);
      expect(await decryptFile(key, sealed, 'f1')).toEqual(plain);
    }
  });

  it('refuses a truncated file, a swapped chunk and another file id', async () => {
    const key = await generateFamilyKey();
    const sealed = await encryptFile(key, bytes(3000), 'f1', 1024);
    // Drop the last chunk entirely: what remains is chunks 0 and 1, and
    // chunk 1 was sealed as "more", not "last"
    await expect(decryptFile(key, sealed.subarray(0, 15 + 2 * (1024 + 16)), 'f1')).rejects.toThrow();
    // Cut mid-chunk
    await expect(decryptFile(key, sealed.subarray(0, sealed.length - 5), 'f1')).rejects.toThrow();
    // Swap chunks 0 and 1
    const swapped = new Uint8Array(sealed);
    swapped.set(sealed.subarray(15 + 1040, 15 + 2 * 1040), 15);
    swapped.set(sealed.subarray(15, 15 + 1040), 15 + 1040);
    await expect(decryptFile(key, swapped, 'f1')).rejects.toThrow();
    await expect(decryptFile(key, sealed, 'f2')).rejects.toThrow();
    await expect(decryptFile(key, new Uint8Array([1, 2, 3]), 'f1')).rejects.toThrow(/Not an encrypted/);
  });
});

describe('keystore', () => {
  it('holds the key for its own scope only, and forgets it on lock', async () => {
    const backend = new MemoryBackend();
    const store = new KeyStore(backend, 'smiths.neiliro.test');
    expect(await store.load()).toBeNull();
    const key = await generateFamilyKey();
    await store.save(key);
    expect(await store.load()).toBe(key);
    // Same browser profile, another family's hostname: not their key
    expect(await new KeyStore(backend, 'jones.neiliro.test').load()).toBeNull();
    await store.lock();
    expect(await store.load()).toBeNull();
  });

  it('degrades to "locked" when storage refuses', async () => {
    const broken = {
      get: async () => {
        throw new Error('blocked');
      },
      put: async () => {
        throw new Error('blocked');
      },
      clear: async () => {
        throw new Error('blocked');
      },
    };
    const store = new KeyStore(broken, 'x');
    await expect(store.save(await generateFamilyKey())).resolves.toBeUndefined();
    expect(await store.load()).toBeNull();
    await expect(store.lock()).resolves.toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  exportFamilyKey,
  familyPrivateKey,
  familyPublicKey,
  fragmentFor,
  generateFamilyKey,
  generateRecoveryCode,
  handoffSecretFromFragment,
  handoffWrapKey,
  importFamilyKey,
  newHandoffSecret,
  publicKeyBytes,
  recoveryWrapKey,
  unwrapFamilyKey,
  wrapFamilyKey,
} from './index';
import { deriveCredentialKeys, saltFromHex } from './kdf';

/*
  The doors to the family key (#210), each as the browser walks it.
  Node 24's WebCrypto has X25519, so the derivation runs here as in a browser.
*/
const SALT = saltFromHex('00112233445566778899aabbccddeeff');
const FAST = 1000; // iterations: tests exercise the flow, not the cost

describe('the X25519 pair derived from the family key', () => {
  it('is deterministic, and the public half is what a peer computes from the private one', async () => {
    const family = await generateFamilyKey();
    const raw = await exportFamilyKey(family);
    const again = await importFamilyKey(raw);
    const pub1 = await familyPublicKey(family);
    const pub2 = await familyPublicKey(again);
    expect(pub1).toBe(pub2);
    expect(publicKeyBytes(pub1)).toHaveLength(32);

    // A different family key, a different pair
    expect(await familyPublicKey(await generateFamilyKey())).not.toBe(pub1);

    // The pair actually agrees: ECDH from the private half against an
    // ephemeral peer equals ECDH from the peer against the exported public half
    const priv = await familyPrivateKey(family);
    const peer = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const familyPub = await crypto.subtle.importKey('raw', publicKeyBytes(pub1), { name: 'X25519' }, true, []);
    const a = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, priv, 256));
    const b = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: familyPub }, peer.privateKey, 256));
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('handing the key on through a link', () => {
  it('the secret rides in the fragment, opens the handoff, and nothing else does', async () => {
    const family = await generateFamilyKey();
    const secret = newHandoffSecret();
    const place = { kind: 'handoff', owner: 'user-ann' };
    const sealed = await wrapFamilyKey(family, await handoffWrapKey(secret), place);

    const link = `https://smiths.example/readmit?id=abc${fragmentFor(secret)}`;
    const fromLink = handoffSecretFromFragment(new URL(link).hash);
    expect(fromLink).toBe(secret);
    const opened = await unwrapFamilyKey(sealed, await handoffWrapKey(fromLink!), place);
    expect(Array.from(await exportFamilyKey(opened))).toEqual(Array.from(await exportFamilyKey(family)));

    // Another secret, or the same secret for another member, opens nothing
    await expect(unwrapFamilyKey(sealed, await handoffWrapKey(newHandoffSecret()), place)).rejects.toThrow();
    await expect(
      unwrapFamilyKey(sealed, await handoffWrapKey(secret), { kind: 'handoff', owner: 'user-bob' }),
    ).rejects.toThrow();
    // A link that lost its fragment has no secret
    expect(handoffSecretFromFragment('')).toBeNull();
    expect(handoffSecretFromFragment('#k=short')).toBeNull();
  });
});

describe('the three doors open the same key', () => {
  it('password envelope, recovery envelope and a re-wrap after a new password', async () => {
    const family = await generateFamilyKey();
    const raw = Array.from(await exportFamilyKey(family));

    const old = await deriveCredentialKeys('old password 123', SALT, FAST);
    const mine = await wrapFamilyKey(family, old.wrapKey, { kind: 'password', owner: 'user-sam' });
    const code = generateRecoveryCode();
    const recovery = await wrapFamilyKey(family, await recoveryWrapKey(code), { kind: 'recovery', owner: 'family' });

    // Sign-in with the password opens the member's envelope
    const viaPassword = await unwrapFamilyKey(mine, old.wrapKey, { kind: 'password', owner: 'user-sam' });
    expect(Array.from(await exportFamilyKey(viaPassword))).toEqual(raw);

    // A password reset: the new wrap key does not open the old envelope...
    const fresh = await deriveCredentialKeys('new password 456', SALT, FAST);
    await expect(unwrapFamilyKey(mine, fresh.wrapKey, { kind: 'password', owner: 'user-sam' })).rejects.toThrow();
    // ...the recovery code does, and the key is re-wrapped under the new password
    const viaCode = await unwrapFamilyKey(recovery, await recoveryWrapKey(code), { kind: 'recovery', owner: 'family' });
    const rewrapped = await wrapFamilyKey(viaCode, fresh.wrapKey, { kind: 'password', owner: 'user-sam' });
    const opened = await unwrapFamilyKey(rewrapped, fresh.wrapKey, { kind: 'password', owner: 'user-sam' });
    expect(Array.from(await exportFamilyKey(opened))).toEqual(raw);

    // Another member's password never opens it
    const ann = await deriveCredentialKeys('old password 123', saltFromHex('ffeeddccbbaa99887766554433221100'), FAST);
    await expect(unwrapFamilyKey(mine, ann.wrapKey, { kind: 'password', owner: 'user-sam' })).rejects.toThrow();
  });
});

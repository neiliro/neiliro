import { describe, expect, it } from 'vitest';
import { generateFamilyKey, utf8 } from './index';
import { familyPublicKey } from './x25519';
import { isSealedFile, openSealedField, openSealedFile, sealField, sealFile } from './seal';

/*
  Sealing to the family public key (#223). The server seals and the
  browser opens; the construction is pinned from the browser's side so a
  server change that drifts from it fails here before it ships.
*/
describe('sealed fields', () => {
  it('open only with the family key they were sealed to, and only in their place', async () => {
    const family = await generateFamilyKey();
    const pub = await familyPublicKey(family);
    const place = { table: 'mail_messages', column: 'subject', id: 'm1' };

    const sealed = await sealField(pub, 'Swimming on Friday', place);
    expect(sealed.startsWith('s1:')).toBe(true);
    expect(await openSealedField(family, sealed, place)).toBe('Swimming on Friday');

    await expect(openSealedField(family, sealed, { ...place, id: 'm2' })).rejects.toThrow();
    await expect(openSealedField(await generateFamilyKey(), sealed, place)).rejects.toThrow();
  });

  it('every sealing uses a fresh ephemeral key', async () => {
    const pub = await familyPublicKey(await generateFamilyKey());
    const place = { table: 't', column: 'c', id: '1' };
    const a = await sealField(pub, 'x', place);
    const b = await sealField(pub, 'x', place);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });
});

describe('sealed files', () => {
  it('round-trip, bound to the file id', async () => {
    const family = await generateFamilyKey();
    const pub = await familyPublicKey(family);
    const plain = utf8('%PDF-1.4 a school letter'.repeat(1000));
    const sealed = await sealFile(pub, plain, 'file-1');
    expect(isSealedFile(sealed)).toBe(true);
    expect(await openSealedFile(family, sealed, 'file-1')).toEqual(plain);
    await expect(openSealedFile(family, sealed, 'file-2')).rejects.toThrow();
  });
});

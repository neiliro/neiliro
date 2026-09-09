/*
  Client-side encryption of what people write — ADR 0001, epic #208.

  Nothing here talks to the server or to React. The pieces:

    kdf.ts       password → authKey (to the server) + wrapKey (stays here)
    envelope.ts  the `e1:` field format, the `w1:` wrapped-key format, the family key
    files.ts     the chunked file format for attachments
    recovery.ts  the recovery code and its wrap key
    keystore.ts  the family key between page loads (IndexedDB), and "Lock"
    x25519.ts    the family's key pair, derived from the family key (#223 seals mail to it)
    handoff.ts   passing the key to another browser through a link's fragment (#210, #212)
    seal.ts      opening what the server sealed to the family's public key (#223)

  The server never holds a wrapKey, the family key, or a recovery code.
  It stores envelopes it cannot open and ciphertext it cannot read, and
  computes with the columns that stay in the clear.
*/
export * from './encoding';
export * from './kdf';
export * from './envelope';
export * from './files';
export * from './recovery';
export * from './keystore';
export * from './x25519';
export * from './handoff';
export * from './session';
export * from './seal';

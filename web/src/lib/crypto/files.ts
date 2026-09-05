import { concat, randomBytes, utf8, type Bytes } from './encoding';

/*
  The file envelope — attachments, receipts, mail parts (#214, #222).

  Layout, all big-endian:

    "NE1"            3 bytes   magic + version
    chunkSize        4 bytes   plaintext bytes per chunk (last may be shorter)
    noncePrefix      8 bytes   random, one per file
    chunk[i]         chunkSize + 16 bytes of AES-GCM ciphertext+tag

  Each chunk's nonce is noncePrefix || counter(4 bytes), so no two chunks
  of a file share a nonce and no chunk can be swapped, dropped or
  replayed: the AAD carries the file id, the chunk index and whether it is
  the last one. A truncated file fails on its last chunk rather than
  passing as a shorter file.

  One megabyte chunks: a 20 MB photo is never held twice in memory, and
  the per-chunk overhead (16 bytes) is noise. The chunk size is written in
  the header so it can change without a format bump.
*/

const MAGIC = utf8('NE1');
export const DEFAULT_CHUNK = 1024 * 1024;
const TAG = 16;
const HEADER = 3 + 4 + 8;

export class FileEnvelopeError extends Error {}

function nonce(prefix: Bytes, index: number): Bytes {
  const n = new Uint8Array(12);
  n.set(prefix, 0);
  new DataView(n.buffer).setUint32(8, index, false);
  return n;
}

const aad = (fileId: string, index: number, last: boolean): Bytes =>
  utf8(`file/${fileId}/${index}/${last ? 'last' : 'more'}`);

export async function encryptFile(
  key: CryptoKey,
  plain: Bytes,
  fileId: string,
  chunkSize: number = DEFAULT_CHUNK,
): Promise<Bytes> {
  if (chunkSize < 1 || chunkSize > 0xffffffff) throw new FileEnvelopeError('Bad chunk size');
  const prefix = randomBytes(8);
  const header = new Uint8Array(HEADER);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(3, chunkSize, false);
  header.set(prefix, 7);

  // An empty file is one empty chunk, so it still authenticates as "the
  // whole file" rather than as nothing.
  const count = Math.max(1, Math.ceil(plain.length / chunkSize));
  const parts: Uint8Array[] = [header];
  for (let i = 0; i < count; i++) {
    const slice = plain.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, plain.length));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce(prefix, i), additionalData: aad(fileId, i, i === count - 1) },
      key,
      slice,
    );
    parts.push(new Uint8Array(ct));
  }
  return concat(...parts);
}

export async function decryptFile(key: CryptoKey, sealed: Bytes, fileId: string): Promise<Bytes> {
  if (sealed.length < HEADER || sealed[0] !== MAGIC[0] || sealed[1] !== MAGIC[1] || sealed[2] !== MAGIC[2]) {
    throw new FileEnvelopeError('Not an encrypted file');
  }
  const view = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const chunkSize = view.getUint32(3, false);
  if (chunkSize < 1) throw new FileEnvelopeError('Malformed file envelope');
  const prefix = sealed.subarray(7, 15);
  const body = sealed.subarray(HEADER);
  const sealedChunk = chunkSize + TAG;
  // Every chunk but the last is exactly chunkSize+16; the last is at least
  // a tag. Anything else is a truncated or padded file.
  const count = Math.max(1, Math.ceil(body.length / sealedChunk));
  const lastLen = body.length - (count - 1) * sealedChunk;
  if (lastLen < TAG) throw new FileEnvelopeError('Truncated file envelope');

  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const slice = body.subarray(i * sealedChunk, Math.min((i + 1) * sealedChunk, body.length));
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(prefix, i), additionalData: aad(fileId, i, i === count - 1) },
        key,
        slice,
      );
      out.push(new Uint8Array(pt));
    } catch {
      throw new FileEnvelopeError('Cannot decrypt this file here');
    }
  }
  return concat(...out);
}

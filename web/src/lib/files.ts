import { t } from './i18n';
import { decryptFile, encryptFile } from './crypto';
import { hasFamilyKey, openFields, sealFields, vaultKey, VaultLockedError } from './vault';

/*
  Attachments under the family key (#222).

  A file is encrypted here before it is uploaded, with the file envelope
  from lib/crypto/files.ts, bound to an id this side mints — the multipart
  field is named `sealed:<id>` so the server can tell the two kinds of
  upload apart. The filename is words and goes as a field envelope. The
  server stores bytes it cannot read and hands them back as an opaque
  download with the envelope kind in a header; `attachmentUrl` fetches,
  opens and returns a blob URL, so an <img> or a download link works as
  before. A plaintext file (from before the key, or a family without one)
  is served as it always was and its URL passes straight through.

  The service worker caches /api/attachments/ responses CacheFirst. That
  is ciphertext now, decrypted after the fetch on every load — the cache
  never sees a plaintext byte, which is the right thing on a lost phone.
*/

export interface UploadedFile {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  is_image: boolean;
  encryption: number;
  url: string;
}

const bytesOf = async (file: Blob): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await file.arrayBuffer());

/** Upload files to a notes or transactions attachment route, sealed when the key is here. */
export async function uploadAttachments(path: string, files: File[]): Promise<UploadedFile[]> {
  const key = vaultKey();
  if (!key && hasFamilyKey()) throw new VaultLockedError();

  const form = new FormData();
  for (const file of files) {
    if (!key) {
      form.append('file', file);
      continue;
    }
    const id = crypto.randomUUID();
    const sealed = await encryptFile(key, await bytesOf(file), id);
    const { filename } = await sealFields('attachments', id, { filename: file.name }, ['filename']);
    form.append(`sealed:${id}`, new Blob([sealed], { type: file.type || 'application/octet-stream' }), filename);
  }

  const res = await fetch(`/api${path}`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(t(body?.error ?? 'Could not upload the file'));
  }
  const { uploaded } = (await res.json()) as { uploaded: UploadedFile[] };
  return Promise.all(
    uploaded.map(async (u) => {
      const opened = await openFields('attachments', u.id, { filename: u.filename }, ['filename']);
      return { ...u, filename: opened.filename };
    }),
  );
}

// Blob URLs by attachment id, for the life of the tab. A blob URL is a
// decrypted file held in memory; revoking on navigation would make every
// re-render re-fetch and re-decrypt a photo, and the tab is the trust
// boundary anyway — the key itself lives in the same memory.
const urls = new Map<string, Promise<string>>();

/** A URL an <img> or <a> can use, decrypting first when the file is sealed. */
export function attachmentUrl(id: string, mime?: string): Promise<string> {
  const cached = urls.get(id);
  if (cached) return cached;
  const pending = (async () => {
    const res = await fetch(`/api/attachments/${id}`);
    if (!res.ok) throw new Error(t('File not found'));
    const kind = Number(res.headers.get('X-Neiliro-Encryption') ?? '0');
    if (kind === 0) return `/api/attachments/${id}`;
    const key = vaultKey();
    if (!key) throw new VaultLockedError();
    if (kind !== 1) throw new Error(t('This file is sealed for the family and cannot be opened here yet'));
    const plain = await decryptFile(key, new Uint8Array(await res.arrayBuffer()), id);
    return URL.createObjectURL(new Blob([plain], { type: mime ?? '' }));
  })();
  pending.catch(() => urls.delete(id));
  urls.set(id, pending);
  return pending;
}

/** The one-time job: fetch a plaintext file, seal it under its own id, put it back in place. */
export async function encryptExistingAttachment(id: string, filename: string, mime: string): Promise<void> {
  const key = vaultKey();
  if (!key) throw new VaultLockedError();
  const res = await fetch(`/api/attachments/${id}`);
  if (!res.ok) throw new Error(t('File not found'));
  if (res.headers.get('X-Neiliro-Encryption')) return; // already done, by another device
  const sealed = await encryptFile(key, new Uint8Array(await res.arrayBuffer()), id);
  const { filename: sealedName } = await sealFields('attachments', id, { filename }, ['filename']);
  const form = new FormData();
  form.append(`sealed:${id}`, new Blob([sealed], { type: mime || 'application/octet-stream' }), sealedName);
  const put = await fetch(`/api/attachments/${id}`, { method: 'PUT', body: form });
  if (!put.ok) {
    const body = (await put.json().catch(() => null)) as { error?: string } | null;
    throw new Error(t(body?.error ?? 'Could not upload the file'));
  }
  urls.delete(id);
}

import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentTenant, db, id, now, today } from '../db/index.js';

/** The per-file ceiling. Beyond it this is no longer a note but file storage. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The storage budget: below it — warn in the UI, above it — refuse. */
const BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|avif|heic|svg\+xml)$/;

/*
  Only raster formats may be served inline. SVG is a document with
  scripts: opened directly at /api/attachments/:id, it would execute
  with the hub's origin. CSP script-src 'self' already mutes that, but
  defense must not rest on a single layer. SVG keeps showing in note
  <img> tags — images don't care about the Content-Disposition header.
*/
const INLINE_MIME = /^image\/(png|jpeg|gif|webp|avif|heic)$/;

/** MIME comes from the client: whatever doesn't look like MIME becomes octet-stream. */
function safeMime(mime: string): string {
  return /^[\w.+-]{1,80}\/[\w.+-]{1,80}$/.test(mime) ? mime : 'application/octet-stream';
}

interface AttachmentRow {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  storage_path: string;
  note_id: string | null;
  transaction_id: string | null;
}

/*
  Who may see an attachment, as one expression rather than one per caller.

  An attachment inherits the privacy of whatever it hangs on: a note's
  visibility, or the account behind a transaction. Both have to be asked,
  because a receipt on a personal account carries `note_id IS NULL` — and
  a guard that only looked at the note clause therefore let every
  member's receipt filenames through. That is exactly what happened in
  global search (#184): the row was hidden from the money screens and
  from a direct fetch, and named in search results.

  Mail attachments hang on neither and stay visible: family mail has no
  owner_id, it belongs to the household by design.

  Shared so that the three places privacy has to agree in — the list, the
  search and the direct fetch — agree by construction. Two `?` for the
  reader's id, in this order.
*/
export const ATTACHMENT_VISIBLE_JOINS = `LEFT JOIN notes n ON n.id = a.note_id
         LEFT JOIN transactions t ON t.id = a.transaction_id
         LEFT JOIN accounts acc ON acc.id = t.account_id`;

export const ATTACHMENT_VISIBLE = `(a.note_id IS NULL OR n.visibility = 'shared' OR n.owner_id = ?)
          AND (a.transaction_id IS NULL OR acc.shared = 1 OR acc.owner_id = ?)`;

/**
 * A human-supplied filename never takes part in the on-disk path.
 * The file is stored under a generated name while the original name
 * lives in the database — otherwise "../../" in a name would steer
 * the write anywhere.
 */
function storageNameFor(originalName: string): string {
  const ext = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${id()}${ext.slice(0, 12)}`;
}

/** The header for serving: the name may be in any language. */
function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename,
  )}`;
}

/** An attachment is visible to whoever can see the thing it hangs on. */
function loadVisible(attachmentId: string, userId: string): AttachmentRow | null {
  const row = db
    .prepare(
      `SELECT a.* FROM attachments a
         ${ATTACHMENT_VISIBLE_JOINS}
        WHERE a.id = ?
          AND ${ATTACHMENT_VISIBLE}`,
    )
    .get(attachmentId, userId, userId) as AttachmentRow | undefined;
  return row ?? null;
}

interface UploadedInfo {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  is_image: boolean;
  url: string;
}

/**
 * Attachment arriving as a buffer (a MIME part of a family-mail
 * message) rather than a multipart upload. Same storage layout, same
 * budget; an oversized part or a full store skips the file rather than
 * failing the whole message — the text always lands.
 */
export async function saveMailAttachment(
  mailMessageId: string,
  file: { filename: string; mime: string; content: Buffer },
): Promise<void> {
  if (file.content.length === 0 || file.content.length > MAX_FILE_BYTES) return;
  const { used } = db
    .prepare('SELECT coalesce(sum(size_bytes), 0) AS used FROM attachments')
    .get() as { used: number };
  if (used + file.content.length > BUDGET_BYTES) return;

  const storageName = storageNameFor(file.filename);
  const month = today().slice(0, 7);
  const folder = join(currentTenant().attachmentsDir, month);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, storageName), file.content);

  db.prepare(
    `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path, mail_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id(),
    file.filename.slice(0, 300),
    safeMime(file.mime),
    file.content.length,
    join(month, storageName),
    mailMessageId,
    now(),
  );
}

/**
 * Files are accepted as one piece: either all are saved, or none.
 *
 * Exceeding the limit on the second file used to return a 413, but the
 * first one already sat on disk and in the database — the client saw an
 * error while half the attachments quietly attached. Now a refusal rolls
 * back both the records and the files.
 */
async function receiveFiles(
  req: FastifyRequest,
  reply: FastifyReply,
  target: { note_id: string | null; transaction_id: string | null },
): Promise<UploadedInfo[] | null> {
  const uploaded: UploadedInfo[] = [];
  const savedPaths: string[] = [];

  const rollback = async (): Promise<void> => {
    if (uploaded.length > 0) {
      db.prepare(
        `DELETE FROM attachments WHERE id IN (${uploaded.map(() => '?').join(',')})`,
      ).run(...uploaded.map((u) => u.id));
    }
    for (const path of savedPaths) await unlink(path).catch(() => {});
  };

  // The budget is checked on entry: what's already accepted isn't recalled,
  // but the next request atop an overflowing store gets a refusal instead
  // of the disk drained to the bottom
  const { used } = db
    .prepare('SELECT coalesce(sum(size_bytes), 0) AS used FROM attachments')
    .get() as { used: number };
  if (used >= BUDGET_BYTES) {
    await reply.code(413).send({ error: 'Attachment storage is full' });
    return null;
  }

  for await (const part of req.files()) {
    const storageName = storageNameFor(part.filename);
    // The month folder — by the local clock, like everything else in the app
    const month = today().slice(0, 7);
    const folder = join(currentTenant().attachmentsDir, month);
    await mkdir(folder, { recursive: true });
    const fullPath = join(folder, storageName);

    await pipeline(part.file, createWriteStream(fullPath));

    // Exceeding the multipart limit truncates the stream rather than throwing
    if (part.file.truncated) {
      await unlink(fullPath).catch(() => {});
      await rollback();
      await reply
        .code(413)
        .send({ error: `The file exceeds ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB` });
      return null;
    }

    const { size } = await stat(fullPath);
    const attachmentId = id();
    db.prepare(
      `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path, note_id,
                                transaction_id, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attachmentId,
      part.filename,
      safeMime(part.mimetype),
      size,
      // Only the relative path goes in the database: the data directory may move
      join(month, storageName),
      target.note_id,
      target.transaction_id,
      (req.user?.id ?? '') || null,
      now(),
    );

    savedPaths.push(fullPath);
    uploaded.push({
      id: attachmentId,
      filename: part.filename,
      mime: safeMime(part.mimetype),
      size_bytes: size,
      is_image: IMAGE_MIME.test(part.mimetype),
      url: `/api/attachments/${attachmentId}`,
    });
  }

  if (uploaded.length === 0) {
    await reply.code(400).send({ error: 'No file received' });
    return null;
  }
  return uploaded;
}

export async function registerAttachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/attachments/usage', () => {
    const row = db
      .prepare('SELECT coalesce(sum(size_bytes), 0) AS used, count(*) AS files FROM attachments')
      .get() as { used: number; files: number };
    return {
      used: row.used,
      files: row.files,
      budget: BUDGET_BYTES,
      max_file: MAX_FILE_BYTES,
    };
  });

  app.post('/api/notes/:id/attachments', async (req, reply) => {
    const { id: noteId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId = req.user?.id ?? '';

    const note = db
      .prepare(
        `SELECT id FROM notes
          WHERE id = ? AND (visibility = 'shared' OR owner_id = ?)`,
      )
      .get(noteId, userId);
    if (!note) return reply.code(404).send({ error: 'Note not found' });

    const uploaded = await receiveFiles(req, reply, { note_id: noteId, transaction_id: null });
    if (!uploaded) return;
    return reply.code(201).send({ uploaded });
  });

  app.post('/api/transactions/:id/attachments', async (req, reply) => {
    const { id: txId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const userId = req.user?.id ?? '';

    const tx = db
      .prepare(
        `SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE t.id = ? AND (a.shared = 1 OR a.owner_id = ?)`,
      )
      .get(txId, userId);
    if (!tx) return reply.code(404).send({ error: 'Transaction not found' });

    const uploaded = await receiveFiles(req, reply, { note_id: null, transaction_id: txId });
    if (!uploaded) return;
    return reply.code(201).send({ uploaded });
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    const { id: attachmentId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { download } = z.object({ download: z.string().optional() }).parse(req.query);

    const attachment = loadVisible(attachmentId, req.user?.id ?? '');
    if (!attachment) return reply.code(404).send({ error: 'File not found' });

    const fullPath = resolve(currentTenant().attachmentsDir, attachment.storage_path);
    // Insurance against escaping the attachments directory
    if (!fullPath.startsWith(resolve(currentTenant().attachmentsDir))) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      await stat(fullPath);
    } catch {
      return reply.code(404).send({ error: 'The file is missing on disk' });
    }

    const inline = download !== 'true' && INLINE_MIME.test(attachment.mime);
    return reply
      .header('Content-Type', safeMime(attachment.mime))
      .header('Content-Disposition', contentDisposition(attachment.filename, inline))
      // Content under an id never changes; safe to cache for a long time
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(createReadStream(fullPath));
  });

  app.delete('/api/attachments/:id', async (req, reply) => {
    const { id: attachmentId } = z.object({ id: z.string().uuid() }).parse(req.params);

    const attachment = loadVisible(attachmentId, req.user?.id ?? '');
    if (!attachment) return reply.code(404).send({ error: 'File not found' });

    db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId);
    // The record is deleted either way; a file missing from disk is no reason to crash
    await unlink(resolve(currentTenant().attachmentsDir, attachment.storage_path)).catch(() => {});

    return { ok: true };
  });
}

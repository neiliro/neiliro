import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { isCiphertext } from '../lib/ciphertext.js';
import {
  familyMailAddress,
  getMailAccount,
  MailSendError,
  mailSource,
  pollMail,
  sendReply,
} from '../lib/mail.js';
import { log } from '../lib/log.js';

/** The seeded Inbox project (migration 004) — the natural home for mail-born tasks. */
const INBOX_PROJECT_ID = '00000000-0000-4000-8000-000000000001';

const LIST_COLUMNS = `id, kind, from_address, from_name, to_address, subject, sent_at,
                      received_at, read_at, task_id, in_reply_to, sent_by`;

export async function registerMailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mail', () => {
    const messages = db
      .prepare(
        `SELECT ${LIST_COLUMNS},
                (SELECT count(*) FROM attachments a WHERE a.mail_message_id = m.id) AS attachment_count
           FROM mail_messages m
          WHERE kind = 'in'
          ORDER BY received_at DESC
          LIMIT 200`,
      )
      .all();
    const account = getMailAccount();
    /*
      "Configured" means the family has an address, not that it connected
      a mailbox: a hosted family is handed one by the service and its mail
      arrives over the webhook, with no account row to show. Sync state
      belongs to IMAP only — there is nothing to poll in service mode.
    */
    return {
      messages,
      configured: mailSource() !== null,
      source: mailSource(),
      last_sync_at: account?.last_sync_at ?? null,
      last_error: account?.last_error ?? null,
      address: familyMailAddress(),
    };
  });

  app.get('/api/mail/:id', (req, reply) => {
    const { id: messageId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const message = db
      .prepare(`SELECT ${LIST_COLUMNS}, body_text FROM mail_messages WHERE id = ?`)
      .get(messageId) as { id: string; read_at: string | null } | undefined;
    if (!message) return reply.code(404).send({ error: 'Message not found' });

    // Opening a message reads it — for the whole family: the household
    // desk has one "handled" state, not a per-person one
    if (!message.read_at) {
      db.prepare('UPDATE mail_messages SET read_at = ? WHERE id = ?').run(now(), messageId);
      message.read_at = now();
    }

    const attachments = db
      .prepare(
        `SELECT id, filename, mime, size_bytes, encryption FROM attachments WHERE mail_message_id = ?`,
      )
      .all(messageId);
    const replies = db
      .prepare(
        `SELECT m.id, m.subject, m.body_text, m.received_at, u.name AS sent_by_name
           FROM mail_messages m LEFT JOIN users u ON u.id = m.sent_by
          WHERE m.in_reply_to = ? ORDER BY m.received_at`,
      )
      .all(messageId);
    return { ...message, attachments, replies };
  });

  /**
   * One click: the letter becomes a task in the Inbox project. For a sealed
   * letter the browser creates the task itself — it is the only side that
   * can read the subject (#223) — and hands the id over here to be linked.
   */
  app.post('/api/mail/:id/task', (req, reply) => {
    const { id: messageId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = z.object({ task_id: z.string().uuid().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });
    const message = db
      .prepare(`SELECT id, subject, body_text, task_id FROM mail_messages WHERE id = ?`)
      .get(messageId) as
      | { id: string; subject: string; body_text: string; task_id: string | null }
      | undefined;
    if (!message) return reply.code(404).send({ error: 'Message not found' });
    if (message.task_id) {
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(message.task_id);
      if (existing) return reply.code(200).send(existing);
    }
    if (parsed.data.task_id) {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parsed.data.task_id);
      if (!task) return reply.code(400).send({ error: 'Task not found' });
      db.prepare('UPDATE mail_messages SET task_id = ? WHERE id = ?').run(parsed.data.task_id, messageId);
      return reply.code(201).send(task);
    }
    if (isCiphertext(message.subject)) {
      return reply.code(400).send({ error: 'The browser creates the task for an encrypted letter' });
    }

    const taskId = id();
    const excerpt = message.body_text.slice(0, 1000).trim();
    db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, description, status, priority, position, created_by)
       VALUES (?, ?, 0, ?, ?, 'todo', 'normal',
               (SELECT coalesce(max(position), 0) + 1 FROM tasks WHERE project_id = ?), ?)`,
    ).run(
      taskId,
      INBOX_PROJECT_ID,
      (message.subject || '(no subject)').slice(0, 300),
      excerpt || null,
      INBOX_PROJECT_ID,
      req.user?.id ?? null,
    );
    db.prepare('UPDATE mail_messages SET task_id = ? WHERE id = ?').run(taskId, messageId);
    return reply.code(201).send(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  });

  app.post('/api/mail/:id/reply', async (req, reply) => {
    const { id: messageId } = z.object({ id: z.string().uuid() }).parse(req.params);
    // The browser names the recipient and the subject: for a sealed letter
    // the server cannot read either (#223). A plaintext letter from before
    // the key still lets the server fill them in.
    const parsed = z
      .object({
        text: z.string().min(1).max(50_000),
        to: z.string().email().max(300).optional(),
        subject: z.string().max(998).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Reply text is required' });

    const message = db
      .prepare(
        `SELECT id, message_id, from_address, subject FROM mail_messages WHERE id = ? AND kind = 'in'`,
      )
      .get(messageId) as
      | { id: string; message_id: string | null; from_address: string; subject: string }
      | undefined;
    if (!message) return reply.code(404).send({ error: 'Message not found' });

    const to = parsed.data.to ?? (isCiphertext(message.from_address) ? null : message.from_address);
    const subject =
      parsed.data.subject ??
      (isCiphertext(message.subject) ? null : /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`);
    if (to === null || subject === null) {
      return reply.code(400).send({ error: 'The browser names the recipient and the subject for an encrypted letter' });
    }
    const user = req.user!;
    try {
      const replyId = await sendReply(message, { to, subject, text: parsed.data.text }, { id: user.id, name: user.name });
      return reply.code(201).send({ id: replyId });
    } catch (err) {
      if (!(err instanceof MailSendError)) throw err;
      // A refusal by the provider is not an outage: 502 with a sentence the
      // person can act on, the provider's own words in the log for the operator
      log.warn(`mail reply refused for message ${messageId}: ${err.detail}`);
      return reply.code(502).send({ error: err.message });
    }
  });

  /** Rewriting a letter's words — for the one-time job that brings old plaintext under the key (#223). */
  app.patch('/api/mail/:id', (req, reply) => {
    const { id: messageId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = z
      .object({
        from_address: z.string().max(4_000).optional(),
        from_name: z.string().max(4_000).nullable().optional(),
        to_address: z.string().max(4_000).nullable().optional(),
        subject: z.string().max(4_000).optional(),
        body_text: z.string().max(400_000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });
    const fields = Object.entries(parsed.data).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });
    const result = db
      .prepare(`UPDATE mail_messages SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map(([, v]) => v as string | null), messageId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Message not found' });
    return db.prepare(`SELECT ${LIST_COLUMNS}, body_text FROM mail_messages WHERE id = ?`).get(messageId);
  });

  /** Mailbox connection settings — administrator only, password write-only. */
  app.get('/api/mail/account', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const account = getMailAccount();
    // The service address is reported either way: a family that connects
    // its own mailbox should still see the address it can hand out.
    const serviceAddress = mailSource() === 'service' ? familyMailAddress() : null;
    if (!account) return { configured: false, service_address: serviceAddress };
    const { password, ...rest } = account;
    return { configured: true, ...rest, has_password: password.length > 0, service_address: null };
  });

  app.put('/api/mail/account', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const parsed = z
      .object({
        address: z.string().email('Enter a valid email address').max(300),
        imap_host: z.string().min(1).max(300),
        imap_port: z.number().int().min(1).max(65535).default(993),
        smtp_host: z.string().min(1).max(300),
        smtp_port: z.number().int().min(1).max(65535).default(465),
        username: z.string().min(1).max(300),
        // Optional on update: an empty value keeps the stored password
        password: z.string().max(500).optional(),
        folder: z.string().min(1).max(200).default('INBOX'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;
    const existing = getMailAccount();
    const password = d.password || existing?.password;
    if (!password) return reply.code(400).send({ error: 'Password is required' });

    db.prepare(
      `INSERT INTO mail_account (id, address, imap_host, imap_port, smtp_host, smtp_port,
                                 username, password, folder)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         address = excluded.address, imap_host = excluded.imap_host,
         imap_port = excluded.imap_port, smtp_host = excluded.smtp_host,
         smtp_port = excluded.smtp_port, username = excluded.username,
         password = excluded.password, folder = excluded.folder,
         last_error = NULL`,
    ).run(d.address, d.imap_host, d.imap_port, d.smtp_host, d.smtp_port, d.username, password, d.folder);
    return { ok: true };
  });

  app.delete('/api/mail/account', (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    db.prepare('DELETE FROM mail_account WHERE id = 1').run();
    return { ok: true };
  });

  /** Manual poll — doubles as the connection test after saving settings. */
  app.post('/api/mail/sync', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    // Service mode has nothing to poll — the webhook pushes instead.
    if (!getMailAccount()) {
      return reply.code(400).send({ error: 'No mailbox to poll' });
    }
    const result = await pollMail();
    if ('error' in result) return reply.code(502).send({ error: result.error });
    return result;
  });
}

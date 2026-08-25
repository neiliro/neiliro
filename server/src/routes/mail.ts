import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import {
  familyMailAddress,
  getMailAccount,
  mailSource,
  pollMail,
  sendReply,
} from '../lib/mail.js';

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
        `SELECT id, filename, mime, size_bytes FROM attachments WHERE mail_message_id = ?`,
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

  /** One click: the letter becomes a task in the Inbox project. */
  app.post('/api/mail/:id/task', (req, reply) => {
    const { id: messageId } = z.object({ id: z.string().uuid() }).parse(req.params);
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
    const parsed = z.object({ text: z.string().min(1).max(50_000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Reply text is required' });

    const message = db
      .prepare(
        `SELECT id, message_id, from_address, subject FROM mail_messages WHERE id = ? AND kind = 'in'`,
      )
      .get(messageId) as
      | { id: string; message_id: string | null; from_address: string; subject: string }
      | undefined;
    if (!message) return reply.code(404).send({ error: 'Message not found' });

    const user = req.user!;
    const replyId = await sendReply(message, parsed.data.text, { id: user.id, name: user.name });
    return reply.code(201).send({ id: replyId });
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

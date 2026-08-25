import PostalMime, { type Email } from 'postal-mime';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { currentTenant, db, id, now } from '../db/index.js';
import { env } from '../env.js';
import { saveMailAttachment } from '../routes/attachments.js';
import { log } from './log.js';
import { familySlug } from './tenants.js';

/*
  Family mail (#30/#31), the core.

  ingestEmail() is deliberately source-agnostic: it takes raw MIME and
  knows nothing about where it came from. v1 feeds it from an IMAP
  poller; the future hosted mode will feed the same function from an
  inbound webhook. Everything downstream (list, task creation,
  attachments) works on mail_messages rows and never sees a source.
*/

export interface MailAccount {
  id: number;
  address: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string;
  folder: string;
  last_sync_at: string | null;
  last_error: string | null;
}

export function getMailAccount(): MailAccount | null {
  return (db.prepare('SELECT * FROM mail_account WHERE id = 1').get() as MailAccount) ?? null;
}

/*
  Where a family's mail comes from and goes out through.

  Two sources, one product. A self-hosted family brings its own mailbox
  (mail_account, polled over IMAP). A hosted family is handed an address
  on the service domain and fed by the inbound webhook instead. Both end
  up as mail_messages rows, and both reply from the family address — the
  rest of the module cannot tell them apart.
*/

/**
 * The service-issued address, derived from the slug and never stored: a
 * family that gets renamed gets a renamed address, with no row to update
 * and no stale copy to disagree with the registry.
 *
 * Null whenever there is nothing to derive from — a self-hosted install,
 * a demo sandbox, or the ghost (no familyId, so unknown subdomains are
 * not handed an address either).
 */
function serviceAddress(): string | null {
  if (!env.mailDomain) return null;
  const { familyId } = currentTenant();
  if (!familyId) return null;
  const slug = familySlug(familyId);
  return slug ? `${slug}@${env.mailDomain}` : null;
}

/** How this family's mail is fed: its own mailbox, or the service. */
export type MailSource = 'imap' | 'service' | null;

export function mailSource(): MailSource {
  if (getMailAccount()) return 'imap';
  return serviceAddress() ? 'service' : null;
}

/**
 * The family's address, whichever half provides it. A configured mailbox
 * wins: a family that went to the trouble of connecting its own box keeps
 * sending from it even when the service could hand it an address.
 */
export function familyMailAddress(): string | null {
  return getMailAccount()?.address ?? serviceAddress();
}

interface Outgoing {
  address: string;
  transport: nodemailer.Transporter;
}

/**
 * The transport a reply goes out through. Null means this family cannot
 * send at all — no mailbox of its own and no service SMTP configured —
 * which the demo relies on as well.
 */
function outgoing(): Outgoing | null {
  const account = getMailAccount();
  if (account) {
    return {
      address: account.address,
      transport: nodemailer.createTransport({
        host: account.smtp_host,
        port: account.smtp_port,
        secure: account.smtp_port === 465,
        auth: { user: account.username, pass: account.password },
      }),
    };
  }

  const address = serviceAddress();
  if (!address || !env.mailSmtpHost) return null;
  return {
    address,
    // The envelope sender is the service's SMTP user; the From header is
    // the family's own address, which the domain is authorized to send as.
    transport: nodemailer.createTransport({
      host: env.mailSmtpHost,
      port: env.mailSmtpPort,
      secure: env.mailSmtpPort === 465,
      auth: { user: env.mailSmtpUser, pass: env.mailSmtpPass },
    }),
  };
}

/** Sanity cap: a message source larger than this is not household mail. */
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Parses raw MIME and stores the message. Returns the new row id, or
 * null when the message is already known (same Message-ID) — ingest is
 * idempotent, so a re-poll or a restart never duplicates anything.
 */
export async function ingestEmail(raw: Uint8Array | string): Promise<string | null> {
  const email: Email = await PostalMime.parse(raw);

  const messageId = email.messageId?.slice(0, 500) ?? null;
  if (messageId) {
    const known = db
      .prepare('SELECT id FROM mail_messages WHERE message_id = ?')
      .get(messageId);
    if (known) return null;
  }

  const rowId = id();
  db.prepare(
    `INSERT INTO mail_messages (id, message_id, kind, from_address, from_name, to_address,
                                subject, body_text, sent_at, received_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rowId,
    messageId,
    email.from?.address?.slice(0, 300) ?? '(unknown)',
    email.from?.name?.slice(0, 200) || null,
    email.to?.[0]?.address?.slice(0, 300) ?? null,
    (email.subject ?? '').slice(0, 500),
    // The text part; when a message is HTML-only, fall back to a crude
    // tag strip so the reader is never left with an empty body
    (email.text ?? textFromHtml(email.html)).slice(0, 100_000),
    email.date ? email.date.replace('T', ' ').slice(0, 19) : null,
    now(),
  );

  for (const part of email.attachments ?? []) {
    // Inline images of HTML signatures and the like are noise, not documents
    if (part.disposition === 'inline' && !part.filename) continue;
    // postal-mime yields string | ArrayBuffer | Uint8Array depending on encoding
    const content =
      typeof part.content === 'string'
        ? Buffer.from(part.content)
        : part.content instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(part.content))
          : Buffer.from(part.content);
    await saveMailAttachment(rowId, {
      filename: part.filename || 'attachment',
      mime: part.mimeType || 'application/octet-stream',
      content,
    });
  }

  return rowId;
}

/** Last-resort readable text for HTML-only messages. Not a renderer. */
function textFromHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let polling = false;

/**
 * One IMAP pass: fetch unseen messages from the configured folder,
 * ingest, mark seen upstream. Returns how many new messages landed.
 * Failures are recorded on the account row (the UI shows them) and
 * never escape — a broken mailbox must not take the hub down with it.
 */
export async function pollMail(): Promise<{ fetched: number } | { error: string }> {
  const account = getMailAccount();
  if (!account) return { error: 'Mailbox is not configured' };
  if (polling) return { fetched: 0 };
  polling = true;

  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: true,
    auth: { user: account.username, pass: account.password },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(account.folder);
    let fetched = 0;
    try {
      // imapflow returns false on a search the server rejected
      const unseen = (await client.search({ seen: false })) || [];
      for (const uid of unseen) {
        const message = await client.fetchOne(String(uid), { source: { maxLength: MAX_MESSAGE_BYTES } });
        if (!message || !message.source) continue;
        if ((await ingestEmail(message.source)) !== null) fetched += 1;
        // Seen is set only after a successful ingest: a crash between
        // the two leaves the message unseen and re-ingested next pass
        // (the Message-ID index absorbs any overlap)
        await client.messageFlagsAdd(String(uid), ['\\Seen']);
      }
    } finally {
      lock.release();
    }
    await client.logout();

    db.prepare('UPDATE mail_account SET last_sync_at = ?, last_error = NULL WHERE id = 1').run(now());
    if (fetched > 0) log.info(`mail: fetched ${fetched} new message(s)`);
    return { fetched };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 300) : 'Unknown error';
    db.prepare('UPDATE mail_account SET last_error = ? WHERE id = 1').run(reason);
    log.warn('mail: poll failed', err);
    try {
      await client.logout();
    } catch {
      // The connection is already gone — nothing left to close
    }
    return { error: reason };
  } finally {
    polling = false;
  }
}

const POLL_MS = 3 * 60_000;

/**
 * Background polling. A hub with no mailbox configured idles for free.
 *
 * The caller supplies the iteration context: a single-family install
 * passes a run-once wrapper, hosted mode passes forEachFamily — this
 * module stays ignorant of tenants, the same way routes are.
 */
export function startMailPoller(each: (fn: () => unknown) => Promise<void>): void {
  setInterval(() => {
    void each(async () => {
      if (!getMailAccount()) return;
      await pollMail();
    });
  }, POLL_MS).unref();
}

/**
 * Reply from the hub. From is always the family address — the member's
 * name travels in the display name, and replies land back in the family
 * mailbox, which is the whole point. The sent copy becomes a mail row
 * (kind='out'), so the thread reads in one place.
 */
export async function sendReply(
  original: { id: string; message_id: string | null; from_address: string; subject: string },
  text: string,
  sender: { id: string; name: string },
): Promise<string> {
  const out = outgoing();
  if (!out) throw new Error('Mailbox is not configured');

  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  await out.transport.sendMail({
    from: { name: `${sender.name} · ${out.address}`, address: out.address },
    to: original.from_address,
    subject,
    text,
    inReplyTo: original.message_id ?? undefined,
    references: original.message_id ?? undefined,
  });

  const rowId = id();
  db.prepare(
    `INSERT INTO mail_messages (id, kind, from_address, from_name, to_address, subject,
                                body_text, received_at, read_at, in_reply_to, sent_by)
     VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rowId,
    out.address,
    sender.name,
    original.from_address,
    subject,
    text.slice(0, 100_000),
    now(),
    now(),
    original.id,
    sender.id,
  );
  return rowId;
}

import PostalMime, { type Email } from 'postal-mime';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { currentTenant, db, id, now } from '../db/index.js';
import { env } from '../env.js';
import {
  attachmentBytesUsed,
  discardStaged,
  insertStagedAttachment,
  stageMailAttachment,
  type StagedAttachment,
} from '../routes/attachments.js';
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

interface OutgoingMessage {
  /** Shown in front of the family address: "Sam · smiths@mail.example.com" */
  fromName: string;
  to: string;
  subject: string;
  text: string;
  /** Message-ID of the letter being answered, angle brackets included */
  inReplyTo?: string;
}

interface Outgoing {
  address: string;
  send(message: OutgoingMessage): Promise<void>;
}

/**
 * A display name fit for a MIME header. Non-ASCII has to be encoded
 * (RFC 2047), and ours routinely is: the reply name is "<member> · <address>",
 * whose separator alone is outside ASCII before anyone is called Денис.
 */
function mimeDisplayName(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/["\\]/g, '\\$&')}"`;
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
}

/** The family's own mailbox, over its own SMTP. */
function accountSender(account: MailAccount): Outgoing {
  const transport = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure: account.smtp_port === 465,
    auth: { user: account.username, pass: account.password },
  });
  return {
    address: account.address,
    async send(message) {
      await transport.sendMail({
        from: { name: message.fromName, address: account.address },
        to: message.to,
        subject: message.subject,
        text: message.text,
        inReplyTo: message.inReplyTo,
        references: message.inReplyTo,
      });
    },
  };
}

/**
 * The service's own domain, over Mailgun's HTTP API.
 *
 * HTTP and not SMTP on purpose: cloud providers block outbound SMTP —
 * DigitalOcean closes 25/465/587 by default, which is exactly what this
 * machine does — so a reply path over SMTP is one that breaks on the next
 * provider. Port 443 is never blocked.
 *
 * The From header is the family's address; the API key only says who we
 * are to Mailgun. Mailgun authorizes the domain, so every family sends as
 * itself through one credential.
 */
function serviceSender(address: string): Outgoing {
  return {
    address,
    async send(message) {
      const form = new FormData();
      form.set('from', `${mimeDisplayName(message.fromName)} <${address}>`);
      form.set('to', message.to);
      form.set('subject', message.subject);
      form.set('text', message.text);
      if (message.inReplyTo) {
        // Threading headers ride as custom headers on this API
        form.set('h:In-Reply-To', message.inReplyTo);
        form.set('h:References', message.inReplyTo);
      }

      await postToMailgun(form);
    },
  };
}

/**
 * The one place a message leaves for Mailgun. Every outbound path goes
 * through here so that the delivery options are set once, not per sender.
 *
 * `o:tracking=no` is the privacy policy in code: it promises no open or
 * click tracking. Today that holds by accident — everything we send is
 * plain text, and Mailgun tracks opens with a pixel in the HTML part and
 * clicks by rewriting HTML links, so there is nothing for it to touch. The
 * day a message gains an HTML part, the domain's dashboard settings would
 * silently decide for us. Sending the flag makes the promise hold
 * regardless of what is configured on their side (#158).
 */
async function postToMailgun(form: FormData): Promise<void> {
  form.set('o:tracking', 'no');

  const auth = Buffer.from(`api:${env.mailgunApiKey}`).toString('base64');
  const res = await fetch(`${env.mailgunApiBase}/v3/${env.mailDomain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: form,
  });
  if (!res.ok) {
    // The body names the actual reason — an unverified domain, a
    // compliance hold — and the person pressing "send reply" is the
    // one who needs to see it.
    const detail = await res.text().catch(() => '');
    throw new Error(`Mailgun refused the message (${res.status}) ${detail.slice(0, 200)}`.trim());
  }
}

/**
 * How this family sends. Null means it cannot: no mailbox of its own and
 * no service credential — which is also what the demo relies on.
 */
function outgoing(): Outgoing | null {
  const account = getMailAccount();
  if (account) return accountSender(account);

  const address = serviceAddress();
  if (!address || !env.mailgunApiKey) return null;
  return serviceSender(address);
}

/*
  Service mail — the hub writing to a person, not a family writing to the
  world. Password resets are the only case today.

  Sent from a fixed no-reply address on the service domain rather than from
  the family's own address, for two reasons: a reset notice landing in the
  shared family inbox would show every member that someone is recovering an
  account, and a reply to it has nowhere useful to go. `no-reply` is a
  reserved slug, so no family can ever hold that address.
*/

/** Whether the process can send service mail at all. */
export function serviceMailAvailable(): boolean {
  return Boolean(env.mailDomain && env.mailgunApiKey);
}

export async function sendServiceEmail(to: string, subject: string, text: string): Promise<void> {
  if (!serviceMailAvailable()) throw new Error('Service mail is not configured');

  const form = new FormData();
  form.set('from', `${mimeDisplayName('Neiliro')} <no-reply@${env.mailDomain}>`);
  form.set('to', to);
  form.set('subject', subject);
  form.set('text', text);
  await postToMailgun(form);
}

/**
 * Sanity cap: a message source larger than this is not household mail.
 * The IMAP fetch truncates at it; the webhook refuses past it — and does
 * so before parsing, so an oversized delivery costs a length check rather
 * than a run of postal-mime over 25 MB on the shared event loop (#189).
 */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * A message that can never be ingested, however many times it is retried:
 * malformed beyond what postal-mime accepts, or over the size cap. The
 * webhook answers these with a permanent refusal (406) and everything else
 * — a full disk, a busy database — with a retryable one, because ingest
 * is all-or-nothing and the next attempt can succeed (#187).
 */
export class UnparseableMail extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'UnparseableMail';
  }
}

/**
 * Parses raw MIME and stores the message. Returns the new row id, or
 * null when the message is already known (same Message-ID) — ingest is
 * idempotent, so a re-poll or a restart never duplicates anything.
 *
 * All-or-nothing. Attachment files are staged first, then the message
 * row and every attachment row commit in one transaction; if anything
 * fails, the staged files are removed and nothing is left in the
 * database. That is what makes a retry safe: a message that failed is
 * not "known" on the next attempt, and one that succeeded is complete.
 */
export async function ingestEmail(raw: Uint8Array | string): Promise<string | null> {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength;
  if (size > MAX_MESSAGE_BYTES) {
    throw new UnparseableMail(`Message of ${size} bytes is over the ${MAX_MESSAGE_BYTES}-byte cap`);
  }

  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch (err) {
    throw new UnparseableMail('postal-mime could not parse the message', { cause: err });
  }

  const messageId = email.messageId?.slice(0, 500) ?? null;
  const known = () =>
    messageId !== null &&
    db.prepare('SELECT 1 FROM mail_messages WHERE message_id = ?').get(messageId) !== undefined;
  // Cheap exit before any disk work; checked again inside the transaction,
  // where it is authoritative
  if (known()) return null;

  const staged: StagedAttachment[] = [];
  try {
    let used = attachmentBytesUsed();
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
      const s = await stageMailAttachment(
        {
          filename: part.filename || 'attachment',
          mime: part.mimeType || 'application/octet-stream',
          content,
        },
        used,
      );
      if (s) {
        staged.push(s);
        used += s.size;
      }
    }

    const rowId = id();
    // `immediate`: take the write lock at BEGIN, so the duplicate check and
    // the insert cannot interleave with another ingest of the same letter
    const stored = db
      .transaction((): string | null => {
        if (known()) return null;
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
        for (const s of staged) insertStagedAttachment(rowId, s);
        return rowId;
      })
      .immediate();

    if (stored === null) {
      // Lost the race to an identical delivery: its files are the ones that count
      await discardStaged(staged);
      return null;
    }
    return stored;
  } catch (err) {
    await discardStaged(staged);
    throw err;
  }
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
  await out.send({
    fromName: `${sender.name} · ${out.address}`,
    to: original.from_address,
    subject,
    text,
    inReplyTo: original.message_id ?? undefined,
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

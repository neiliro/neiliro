import { t } from '../lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { htmlWorthShowing, sanitizeHtml } from '../lib/sanitize-html';
import { Link, useNavigate } from 'react-router-dom';
import { attachmentUrl } from '../lib/files';
import { looksLikeIcs, parseIcs } from '../lib/ics';
import { useDialogs } from '../components/Dialog';
import { AttachmentLink } from '../components/AttachmentMedia';
import { api } from '../lib/api';
import { INBOX_ID } from '../lib/tasks';
import { useAuth } from '../lib/auth';
import { formatStamp } from '../lib/format';
import { clearBlankOnBlur } from '../lib/forms';
import { Empty, Page } from '../components/Page';

interface MailStub {
  id: string;
  from_address: string;
  from_name: string | null;
  subject: string;
  received_at: string;
  read_at: string | null;
  task_id: string | null;
  attachment_count: number;
}

interface MailAttachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
}

interface MailReply {
  id: string;
  body_text: string;
  received_at: string;
  sent_by_name: string | null;
}

interface MailFull extends MailStub {
  to_address: string | null;
  body_text: string;
  /** The HTML part as sent, or null for text-only and pre-#30 letters; rendered through the sanitizer */
  body_html: string | null;
  sent_at: string | null;
  attachments: MailAttachment[];
  replies: MailReply[];
}

interface MailList {
  messages: MailStub[];
  configured: boolean;
  /** 'imap' when the family connected its own mailbox, 'service' when the
   *  address is issued by the service and fed by the inbound webhook. */
  source: 'imap' | 'service' | null;
  last_sync_at: string | null;
  last_error: string | null;
  address: string | null;
}

function sender(m: MailStub): string {
  return m.from_name || m.from_address;
}

/*
  The letter's body (#30). HTML is shown when it carries more than the
  text part does — a table of charges, a link, an image — and only after
  the sanitizer has rebuilt it from an allowlist (lib/sanitize-html.ts);
  the result is attached as nodes, never as a string. Remote images are
  never fetched: each is a sender learning that the letter was opened and
  from where, so they are counted and named instead. The plain-text part
  is one click away and is what a letter without HTML shows.
*/
function LetterBody({ text, html }: { text: string; html: string | null }) {
  const [view, setView] = useState<'html' | 'text'>(() => (htmlWorthShowing(html) ? 'html' : 'text'));
  const [blocked, setBlocked] = useState(0);
  const [emptyHtml, setEmptyHtml] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view !== 'html' || !html || !box.current) return;
    const out = sanitizeHtml(html);
    box.current.replaceChildren(out.fragment);
    setBlocked(out.blockedImages);
    setEmptyHtml(out.empty);
  }, [view, html]);

  const showingHtml = view === 'html' && html && !emptyHtml;
  return (
    <div className="px-5 py-4">
      {showingHtml ? (
        <div ref={box} className="letter-html max-h-[60vh] overflow-auto text-sm text-ink" />
      ) : (
        <pre className="max-h-[50vh] overflow-y-auto font-sans text-sm whitespace-pre-wrap text-ink">
          {text || t('(empty message)')}
        </pre>
      )}
      {html && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-muted">
          {showingHtml && blocked > 0 && (
            <span>{t('{n} remote images were not loaded — they would tell the sender you opened this.', { n: blocked })}</span>
          )}
          {htmlWorthShowing(html) && !emptyHtml && (
            <button
              type="button"
              onClick={() => setView(view === 'html' ? 'text' : 'html')}
              className="underline underline-offset-2 hover:text-ink"
            >
              {view === 'html' ? t('Show as plain text') : t('Show formatted')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Mail() {
  const { user } = useAuth();
  const [list, setList] = useState<MailList | null>(null);
  const [message, setMessage] = useState<MailFull | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogs = useDialogs();
  const navigate = useNavigate();

  /*
    An invitation becomes an event (#29, #30). The .ics is opened here —
    it is sealed like every attachment, and only the browser can read it —
    parsed, and handed to the calendar as a prefilled dialog: the person
    still picks the calendar and confirms. A recurring invitation is named
    as such and saved as a single event; a file with several events offers
    the first and says how many there were.
  */
  async function addToCalendar(att: MailAttachment) {
    setError(null);
    try {
      const url = await attachmentUrl(att.id, att.mime);
      const text = await (await fetch(url)).text();
      const events = parseIcs(text);
      const first = events[0];
      if (!first) {
        setError(t('No event found in this file.'));
        return;
      }
      if (first.rrule || events.length > 1) {
        const ok = await dialogs.confirm({
          title: t('Add to calendar'),
          message: first.rrule
            ? t('This invitation repeats ({rule}). It is added as a single event on the first date; set the repetition yourself if you want it.', { rule: first.rrule })
            : t('This file holds {n} events. The first one is added; open the file for the rest.', { n: events.length }),
          confirmLabel: t('Continue'),
        });
        if (!ok) return;
      }
      void navigate('/calendar', { state: { prefill: first } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    }
  }

  const load = useCallback(async () => {
    setList(await api.get<MailList>('/mail'));
  }, []);

  useEffect(() => {
    void load().catch(() => setList(null));
  }, [load]);

  async function open(id: string) {
    setError(null);
    setNotice(null);
    setReplyText('');
    const full = await api.get<MailFull>(`/mail/${id}`);
    setMessage(full);
    // Opening marks it read for the whole family — reflect it in the list
    setList((prev) =>
      prev
        ? {
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === id && !m.read_at ? { ...m, read_at: full.received_at } : m,
            ),
          }
        : prev,
    );
  }

  async function makeTask() {
    if (!message) return;
    setBusy(true);
    setError(null);
    try {
      // The task is made here, not on the server: only this side can read a
      // sealed letter's subject (#223). The server links it to the message.
      const created = await api.post<{ id: string }>('/tasks', {
        project_id: INBOX_ID,
        title: (message.subject || t('(no subject)')).slice(0, 300),
        description: message.body_text.slice(0, 1000).trim() || null,
      });
      const task = await api.post<{ id: string }>(`/mail/${message.id}/task`, { task_id: created.id });
      setMessage({ ...message, task_id: task.id });
      setList((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === message.id ? { ...m, task_id: task.id } : m,
              ),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  }

  /*
    A letter leaves the desk (#30). Replies and files go with it; a task
    made from it stays on the board with its own excerpt, which the dialog
    says so nobody hesitates over a handled bill.
  */
  async function deleteLetter() {
    if (!message) return;
    const ok = await dialogs.confirm({
      title: t('Delete this letter?'),
      message: message.task_id
        ? t('The letter, its replies and its files are deleted. The task made from it stays.')
        : t('The letter, its replies and its files are deleted. There is no undo.'),
      confirmLabel: t('Delete letter'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/mail/${message.id}`);
      setMessage(null);
      setList((prev) => (prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== message.id) } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!message || !replyText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Recipient and subject come from here — the server cannot read a sealed letter's
      await api.post(`/mail/${message.id}/reply`, {
        text: replyText.trim(),
        to: message.from_address,
        subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      });
      setReplyText('');
      setNotice(t('Reply sent from the family address'));
      await open(message.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  }

  // The desk is the adults' (#30): the navigation hides it and the server
  // refuses it; a kid who types the address gets a sentence, not a spinner
  if (user?.role === 'kid') {
    return (
      <Page title={t('Mail')}>
        <Empty>{t('The family mailbox is not shown to kid accounts.')}</Empty>
      </Page>
    );
  }

  if (!list) {
    return (
      <Page title={t('Mail')}>
        <div className="h-40 animate-pulse rounded-card bg-surface-3" />
      </Page>
    );
  }

  if (!list.configured && list.messages.length === 0) {
    return (
      <Page title={t('Mail')} eyebrow={t('The household paperwork inbox')}>
        <div className="max-w-xl rounded-card border border-line bg-surface p-6">
          <p className="text-sm text-ink">
            {t('One shared address for school letters, bills and bookings — visible to the whole family, one click from a letter to a task.')}
          </p>
          <p className="mt-3 text-sm text-muted">
            {user?.role === 'admin'
              ? t('Connect the family mailbox in Settings to start.')
              : t('Ask the administrator to connect the family mailbox in Settings.')}
          </p>
          {user?.role === 'admin' && (
            <Link
              to="/settings"
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              {t('Open Settings')}
            </Link>
          )}
        </div>
      </Page>
    );
  }

  return (
    <Page title={t('Mail')} eyebrow={list.address ?? undefined}>
      {list.last_error && (
        <p className="mb-4 rounded-card border border-urgent/40 bg-urgent/10 px-4 py-3 text-sm text-urgent">
          {t('Mailbox sync error: {error}', { error: list.last_error })}
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[24rem_minmax(0,1fr)]">
        {/* List */}
        <div className={message ? 'hidden lg:block' : ''}>
          {list.last_sync_at && (
            <p className="mb-2 font-mono text-xs text-muted">
              {t('Synced {when}', { when: formatStamp(list.last_sync_at) })}
            </p>
          )}
          {list.messages.length === 0 ? (
            <Empty>{t('No mail yet. Forward a letter to the family address — it will appear here.')}</Empty>
          ) : (
            <ul className="overflow-hidden rounded-card border border-line bg-surface">
              {list.messages.map((m) => (
                <li key={m.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    onClick={() => void open(m.id)}
                    className={`flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
                      message?.id === m.id ? 'bg-accent-soft/40' : ''
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={`min-w-0 truncate text-sm ${
                          m.read_at ? 'text-muted' : 'font-semibold text-ink'
                        }`}
                      >
                        {sender(m)}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted">
                        {formatStamp(m.received_at)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${
                          m.read_at ? 'text-muted' : 'text-ink'
                        }`}
                      >
                        {m.subject || t('(no subject)')}
                      </span>
                      {m.attachment_count > 0 && (
                        <span className="shrink-0 font-mono text-xs text-muted" title={t('Has attachments')}>
                          📎
                        </span>
                      )}
                      {m.task_id && (
                        <span className="shrink-0 rounded-full border border-done/40 bg-done/10 px-1.5 font-mono text-[0.625rem] text-done uppercase">
                          {t('task')}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Reader */}
        {message ? (
          <div className="rounded-card border border-line bg-surface">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => setMessage(null)}
                  className="mb-1 text-sm text-muted hover:text-ink lg:hidden"
                >
                  {t('← List')}
                </button>
                <h2 className="font-display text-lg font-semibold text-ink">
                  {message.subject || t('(no subject)')}
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  {sender(message)} · {message.from_address}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {message.task_id ? (
                  <Link
                    to={`/tasks?open=${message.task_id}`}
                    className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-3"
                  >
                    {t('Open task')}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void makeTask()}
                    disabled={busy}
                    className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {t('Make it a task')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void deleteLetter()}
                  disabled={busy}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-urgent disabled:opacity-50"
                  title={t('Delete letter')}
                >
                  {t('Delete')}
                </button>
              </div>
            </div>

            <LetterBody text={message.body_text} html={message.body_html} />

            {message.attachments.length > 0 && (
              <div className="border-t border-line px-5 py-3">
                <p className="eyebrow mb-2">{t('Attachments')}</p>
                <ul className="flex flex-wrap gap-2">
                  {message.attachments.map((a) => (
                    <li key={a.id} className="flex items-center gap-1">
                      <AttachmentLink
                        id={a.id}
                        mime={a.mime}
                        filename={a.filename}
                        download
                        className="inline-block rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink hover:bg-surface-3"
                      >
                        📎 {a.filename}
                      </AttachmentLink>
                      {looksLikeIcs(a.mime, a.filename) && (
                        <button
                          type="button"
                          onClick={() => void addToCalendar(a)}
                          className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:opacity-90"
                          title={t('Open the invitation as a new event in the calendar')}
                        >
                          {t('Add to calendar')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {message.replies.length > 0 && (
              <div className="border-t border-line px-5 py-3">
                <p className="eyebrow mb-2">{t('Replies')}</p>
                <ul className="space-y-3">
                  {message.replies.map((r) => (
                    <li key={r.id} className="rounded-lg bg-surface-2 px-3 py-2">
                      <p className="mb-1 font-mono text-xs text-muted">
                        {r.sent_by_name ?? t('Family')} · {formatStamp(r.received_at)}
                      </p>
                      <pre className="font-sans text-sm whitespace-pre-wrap text-ink">{r.body_text}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="border-t border-line px-5 py-4">
              {notice && <p className="mb-2 text-sm text-done">{notice}</p>}
              {error && <p className="mb-2 text-sm text-urgent">{error}</p>}
              <textarea
                rows={3}
                value={replyText}
                placeholder={t('Reply — it is sent from the family address with your name')}
                onChange={(e) => setReplyText(e.target.value)}
                onBlur={clearBlankOnBlur(() => setReplyText(''))}
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"
              />
              <p className="mt-1 text-xs text-muted">
                {t('A reply is sent by the server, so the server sees what you write here — it is the one sending it. Letters you receive are sealed for the family the moment they arrive.')}
              </p>
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={busy || !replyText.trim()}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {t('Send reply')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="hidden items-center justify-center rounded-card border border-dashed border-line py-20 text-sm text-muted lg:flex">
            {t('Pick a letter on the left')}
          </div>
        )}
      </div>
    </Page>
  );
}

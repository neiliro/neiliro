import { t } from '../lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
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

export function Mail() {
  const { user } = useAuth();
  const [list, setList] = useState<MailList | null>(null);
  const [message, setMessage] = useState<MailFull | null>(null);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      const task = await api.post<{ id: string }>(`/mail/${message.id}/task`, {});
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

  async function sendReply() {
    if (!message || !replyText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/mail/${message.id}/reply`, { text: replyText.trim() });
      setReplyText('');
      setNotice(t('Reply sent from the family address'));
      await open(message.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
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
              </div>
            </div>

            <pre className="max-h-[50vh] overflow-y-auto px-5 py-4 font-sans text-sm whitespace-pre-wrap text-ink">
              {message.body_text || t('(empty message)')}
            </pre>

            {message.attachments.length > 0 && (
              <div className="border-t border-line px-5 py-3">
                <p className="eyebrow mb-2">{t('Attachments')}</p>
                <ul className="flex flex-wrap gap-2">
                  {message.attachments.map((a) => (
                    <li key={a.id}>
                      <a
                        href={`/api/attachments/${a.id}?download=true`}
                        className="inline-block rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink hover:bg-surface-3"
                      >
                        📎 {a.filename}
                      </a>
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

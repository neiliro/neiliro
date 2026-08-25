import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { clearBlankOnBlur } from '../lib/forms';

const field =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
const label = 'mb-1.5 block text-sm font-medium text-ink';

interface AccountInfo {
  configured: boolean;
  /** Hosted: the address the service issued this family, derived from its
   *  subdomain. Mail arrives over the inbound webhook, so there is no
   *  IMAP connection to set up at all. */
  service_address?: string | null;
  address?: string;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
  username?: string;
  folder?: string;
  has_password?: boolean;
  last_sync_at?: string | null;
  last_error?: string | null;
}

const EMPTY = {
  address: '',
  imap_host: '',
  imap_port: '993',
  smtp_host: '',
  smtp_port: '465',
  username: '',
  password: '',
  folder: 'INBOX',
};

/** The family mailbox connection — Settings, administrator only. */
export function MailSection() {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<AccountInfo>('/mail/account')
      .then((a) => {
        setInfo(a);
        if (a.configured) {
          setForm({
            address: a.address ?? '',
            imap_host: a.imap_host ?? '',
            imap_port: String(a.imap_port ?? 993),
            smtp_host: a.smtp_host ?? '',
            smtp_port: String(a.smtp_port ?? 465),
            username: a.username ?? '',
            password: '',
            folder: a.folder ?? 'INBOX',
          });
        }
      })
      .catch(() => setInfo({ configured: false }));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api.put('/mail/account', {
        address: form.address.trim(),
        imap_host: form.imap_host.trim(),
        imap_port: Number(form.imap_port) || 993,
        smtp_host: form.smtp_host.trim(),
        smtp_port: Number(form.smtp_port) || 465,
        username: form.username.trim(),
        // Empty means "keep the stored one" — the password is write-only
        ...(form.password ? { password: form.password } : {}),
        folder: form.folder.trim() || 'INBOX',
      });
      setStatus(t('Saved. Checking the mailbox…'));
      const result = await api.post<{ fetched: number }>('/mail/sync', {});
      setStatus(t('Connected. New messages: {n}', { n: String(result.fetched) }));
      setForm((f) => ({ ...f, password: '' }));
      setInfo((i) => (i ? { ...i, configured: true, has_password: true, last_error: null } : i));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
    } finally {
      setBusy(false);
    }
  }

  if (!info) return null;

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h2 className="eyebrow mb-2">{t('Family mailbox')}</h2>

      {info.service_address ? (
        <div className="mb-4 rounded-card border border-line bg-surface-2 p-4">
          <p className={label}>{t('Your family address')}</p>
          <p className="font-mono text-sm text-ink">{info.service_address}</p>
          <p className="mt-2 text-sm text-muted">
            {t('Letters sent here show up in Mail on their own — there is nothing to connect. Hand it out to the school, the utility company and the booking sites.')}
          </p>
          <p className="mt-2 text-sm text-muted">
            {t('Would rather use a mailbox of your own? Connect it below and it takes over from the address above.')}
          </p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted">
          {t('The shared address the Mail section reads. A dedicated mailbox works best; a personal Gmail works too — filter letters into a separate label and set it as the folder below.')}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className={label}>{t('Family address')}</span>
          <input
            value={form.address}
            placeholder="family@example.com"
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            onBlur={clearBlankOnBlur(() => setForm({ ...form, address: '' }))}
            className={field}
          />
        </label>

        <label className="block">
          <span className={label}>{t('IMAP host')}</span>
          <input
            value={form.imap_host}
            placeholder="imap.gmail.com"
            onChange={(e) => setForm({ ...form, imap_host: e.target.value })}
            onBlur={clearBlankOnBlur(() => setForm({ ...form, imap_host: '' }))}
            className={field}
          />
        </label>
        <label className="block">
          <span className={label}>{t('SMTP host')}</span>
          <input
            value={form.smtp_host}
            placeholder="smtp.gmail.com"
            onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
            onBlur={clearBlankOnBlur(() => setForm({ ...form, smtp_host: '' }))}
            className={field}
          />
        </label>

        <label className="block">
          <span className={label}>{t('Username')}</span>
          <input
            value={form.username}
            autoCapitalize="none"
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            onBlur={clearBlankOnBlur(() => setForm({ ...form, username: '' }))}
            className={field}
          />
        </label>
        <label className="block">
          <span className={label}>{t('Password')}</span>
          <input
            type="password"
            value={form.password}
            placeholder={info.has_password ? t('(unchanged)') : t('App password for Gmail')}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className={field}
          />
        </label>

        <label className="block">
          <span className={label}>{t('Folder to read')}</span>
          <input
            value={form.folder}
            onChange={(e) => setForm({ ...form, folder: e.target.value })}
            onBlur={clearBlankOnBlur(() => setForm({ ...form, folder: 'INBOX' }))}
            className={field}
          />
          <span className="mt-1 block text-xs text-muted">
            {t('INBOX, or a dedicated label so the hub never touches personal mail')}
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !form.address || !form.imap_host || !form.username}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('Save and check')}
        </button>
        {status && <span className="text-sm text-done">{status}</span>}
        {error && <span className="text-sm text-urgent">{error}</span>}
        {!error && info.last_error && (
          <span className="text-sm text-urgent">{info.last_error}</span>
        )}
      </div>
    </section>
  );
}

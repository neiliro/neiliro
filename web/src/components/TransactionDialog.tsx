import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { uploadAttachments } from '../lib/files';
import { AttachmentImage, AttachmentLink } from './AttachmentMedia';
import {
  Modal,
  dialogDanger,
  dialogField,
  dialogGhost,
  dialogLabel,
  dialogPrimary,
} from './Dialog';
import { onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';
import { CategoryChips } from './CategoryChips';
import { shrinkAll } from '../lib/image';
import {
  TX_KIND_LABEL,
  formatAmountInput,
  orderCategories,
  parseAmount,
  type Account,
  type Category,
  type Transaction,
  type TxKind,
} from '../lib/money';

interface Props {
  transaction: Transaction | null;
  defaultAccountId: string;
  defaultKind?: TxKind;
  accounts: Account[];
  categories: Category[];
  today: string;
  onSaved: () => void;
  onClose: () => void;
}

export function TransactionDialog({
  transaction,
  defaultAccountId,
  defaultKind = 'expense',
  accounts,
  categories,
  today,
  onSaved,
  onClose,
}: Props) {
  const editing = transaction !== null;

  const [kind, setKind] = useState<TxKind>(transaction?.kind ?? defaultKind);
  const [draft, setDraft] = useState({
    occurred_on: transaction?.occurred_on ?? today,
    account_id: transaction?.account_id ?? defaultAccountId,
    amount: transaction ? formatAmountInput(transaction.amount) : '',
    to_account_id: transaction?.to_account_id ?? '',
    to_amount: transaction?.to_amount ? formatAmountInput(transaction.to_amount) : '',
    category_id: transaction?.category_id ?? '',
    note: transaction?.note ?? '',
    place: transaction?.place ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipts, setReceipts] = useState<
    { id: string; filename: string; mime: string; size_bytes: number; is_image: number }[]
  >([]);
  const [uploading, setUploading] = useState(false);

  // Receipts are fetched only for an existing transaction: there is
  // nothing to attach to an unsaved one
  useEffect(() => {
    if (!transaction) return;
    void api
      .get<typeof receipts>(`/transactions/${transaction.id}/attachments`)
      .then(setReceipts)
      .catch(() => {});
  }, [transaction]);

  async function uploadReceipts(files: File[]) {
    if (!transaction || files.length === 0) return;
    setUploading(true);
    try {
      // A receipt photo weighs several megabytes, yet all we need from it is the amount and date
      const shrunk = await shrinkAll(files);
      try {
        // Sealed here before the bytes leave the tab when the family has a key (#222)
        await uploadAttachments(`/transactions/${transaction.id}/attachments`, shrunk);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('Could not upload the receipt'));
        return;
      }
      setReceipts(await api.get<typeof receipts>(`/transactions/${transaction.id}/attachments`));
      onSaved();
    } finally {
      setUploading(false);
    }
  }

  async function removeReceipt(receiptId: string) {
    await api.delete(`/attachments/${receiptId}`);
    setReceipts(receipts.filter((r) => r.id !== receiptId));
    onSaved();
  }

  const account = accounts.find((a) => a.id === draft.account_id);
  const toAccount = accounts.find((a) => a.id === draft.to_account_id);
  // Currencies are unlinked: for a transfer between different currencies
  // the second amount is entered by hand, because the system has no exchange rate
  const needsSecondAmount =
    kind === 'transfer' && account && toAccount && account.currency !== toAccount.currency;

  const visibleCategories = orderCategories(categories, kind === 'transfer' ? undefined : kind);

  async function save() {
    const amount = parseAmount(draft.amount);
    if (amount === null || amount === 0) {
      setError(t('Enter an amount above zero'));
      return;
    }

    let toAmount: number | null = null;
    if (kind === 'transfer') {
      if (!draft.to_account_id) {
        setError(t('Choose a destination account'));
        return;
      }
      toAmount = needsSecondAmount ? parseAmount(draft.to_amount) : amount;
      if (toAmount === null || toAmount === 0) {
        setError(t('Enter the amount received'));
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        kind,
        occurred_on: draft.occurred_on,
        account_id: draft.account_id,
        amount,
        to_account_id: kind === 'transfer' ? draft.to_account_id : null,
        to_amount: kind === 'transfer' ? toAmount : null,
        category_id: kind === 'transfer' ? null : draft.category_id || null,
        note: draft.note || null,
        place: draft.place || null,
      };
      if (editing) await api.patch(`/transactions/${transaction.id}`, payload);
      else await api.post('/transactions', payload);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not save'));
      setBusy(false);
    }
  }

  async function remove() {
    if (!transaction) return;
    await api.delete(`/transactions/${transaction.id}`);
    onSaved();
    onClose();
  }

  return (
    <Modal
      title={editing ? t('Transaction') : t('New transaction')}
      width="max-w-md"
      onClose={onClose}
      onSubmit={() => {
        if (!busy) void save();
      }}
      footer={
        <>
          {editing && (
            <button
              type="button"
              onClick={() => void remove()}
              className={`${dialogDanger} mr-auto`}
            >
              {t('Delete')}
            </button>
          )}
          <button type="button" onClick={onClose} className={dialogGhost}>
            {t('Cancel')}
          </button>
          <button type="button" disabled={busy} onClick={() => void save()} className={dialogPrimary}>
            {t('Save')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {(['expense', 'income', 'transfer'] as TxKind[]).map((k) => (
            <button
              key={k}
              type="button"
              data-chip
              onClick={() => {
                setKind(k);
                setDraft((d) => ({ ...d, category_id: '' }));
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                kind === k ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {TX_KIND_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 *:min-w-0">
          <label className="block">
            <span className={dialogLabel}>{kind === 'transfer' ? t('Debit') : t('Amount')}</span>
            <input
              autoFocus
              inputMode="decimal"
              value={draft.amount}
              placeholder="0"
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              onKeyDown={onEnter(() => void save())}
              className={`${dialogField} font-mono text-lg`}
            />
            {account && <span className="mt-1 block text-xs text-muted">{account.currency}</span>}
          </label>

          <label className="block">
            <span className={dialogLabel}>{t('Date')}</span>
            <input
              type="date"
              value={draft.occurred_on}
              onChange={(e) => setDraft({ ...draft, occurred_on: e.target.value })}
              className={dialogField}
            />
          </label>
        </div>

        <label className="block">
          <span className={dialogLabel}>{kind === 'transfer' ? t('From account') : t('Account')}</span>
          <select
            value={draft.account_id}
            onChange={(e) => setDraft({ ...draft, account_id: e.target.value })}
            className={dialogField}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
                {a.shared ? '' : t(' · personal')}
              </option>
            ))}
          </select>
        </label>

        {kind === 'transfer' && (
          <>
            <label className="block">
              <span className={dialogLabel}>{t('To account')}</span>
              <select
                value={draft.to_account_id}
                onChange={(e) => setDraft({ ...draft, to_account_id: e.target.value })}
                className={dialogField}
              >
                <option value="">{t('Choose an account')}</option>
                {accounts
                  .filter((a) => a.id !== draft.account_id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency}
                      {a.shared ? '' : t(' · personal')}
                    </option>
                  ))}
              </select>
            </label>

            {needsSecondAmount && (
              <label className="block">
                <span className={dialogLabel}>{t('Credit')}, {toAccount.currency}</span>
                <input
                  inputMode="decimal"
                  value={draft.to_amount}
                  placeholder="0"
                  onChange={(e) => setDraft({ ...draft, to_amount: e.target.value })}
                  className={`${dialogField} font-mono`}
                />
                <span className="mt-1 block text-xs text-muted">
                  {t('The currencies differ and there is no exchange rate — enter the amount actually received')}
                </span>
              </label>
            )}
          </>
        )}

        {kind !== 'transfer' && (
          <div>
            <span className={dialogLabel}>{t('Category')}</span>
            {visibleCategories.length === 0 ? (
              <p className="text-sm text-muted">
                {t('No categories of this kind yet — create them on the Money page.')}
              </p>
            ) : (
              <CategoryChips
                categories={categories}
                kind={kind}
                value={draft.category_id}
                onChange={(id) => setDraft({ ...draft, category_id: id })}
              />
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 *:min-w-0">
          <label className="block">
            <span className={dialogLabel}>{t('Where')}</span>
            <input
              value={draft.place}
              onChange={(e) => setDraft({ ...draft, place: e.target.value })}
              onBlur={clearBlankOnBlur(() => setDraft({ ...draft, place: '' }))}
              className={dialogField}
            />
          </label>
          <label className="block">
            <span className={dialogLabel}>{t('Note')}</span>
            <input
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              onBlur={clearBlankOnBlur(() => setDraft({ ...draft, note: '' }))}
              onKeyDown={onEnter(() => void save())}
              className={dialogField}
            />
          </label>
        </div>

        {editing && (
          <div>
            <span className={dialogLabel}>{t('Receipt')}</span>
            <div className="flex flex-wrap items-center gap-3">
              <label className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-ink">
                {uploading ? t('Loading…') : t('Attach')}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void uploadReceipts(files);
                  }}
                />
              </label>

              {receipts.map((r) => (
                <span key={r.id} className="flex items-center gap-2">
                  {r.is_image ? (
                    <AttachmentLink id={r.id} mime={r.mime} filename={r.filename}>
                      <AttachmentImage id={r.id} mime={r.mime} alt={r.filename} className="size-10 rounded border border-line object-cover" />
                    </AttachmentLink>
                  ) : (
                    <AttachmentLink id={r.id} mime={r.mime} filename={r.filename} download className="text-sm text-accent underline underline-offset-2">
                      {r.filename}
                    </AttachmentLink>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeReceipt(r.id)}
                    aria-label={t('Remove receipt')}
                    className="text-xs text-muted hover:text-urgent"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">
              {t('The photo is downscaled before upload — it only needs to show the amount and date')}
            </p>
          </div>
        )}

        {!editing && (
          <p className="text-xs text-muted">{t('A receipt can be attached after the transaction is saved.')}</p>
        )}

        {error && <p className="text-sm text-urgent">{error}</p>}
      </div>
    </Modal>
  );
}

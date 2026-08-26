import { t } from '../lib/i18n';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { dialogKeys, onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';

/**
 * Our own dialogs instead of window.prompt and window.confirm.
 *
 * Native popups can't be styled, they fall outside the interface, and on
 * a tablet they behave unpredictably — especially noticeable on the kiosk.
 * Plus they can't be tested automatically: the browser closes them itself.
 */

/*
  The page must not scroll behind an open overlay (#71). Nothing locked it:
  the overlay covers the viewport but the document behind still scrolls,
  and when the dialog itself has nothing to scroll (the common case) the
  wheel chains straight through. Two halves, because either alone leaves
  a case: this lock stops the document, and overscroll-contain on the
  overlay stops a TALL dialog from chaining at its ends.

  A counter rather than a boolean — a confirmation opened on top of a
  dialog must not unlock the page when only it closes. The scrollbar-width
  compensation keeps desktop layout from jumping when the bar disappears.
*/
let scrollLocks = 0;

export function useScrollLock(): void {
  useEffect(() => {
    if (scrollLocks === 0) {
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    }
    scrollLocks += 1;
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      }
    };
  }, []);
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  onSubmit,
  width = 'max-w-sm',
}: {
  title: string;
  children?: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  /** The dialog's primary action — runs on Enter from anywhere in the window. */
  onSubmit?: () => void;
  width?: string;
}) {
  useScrollLock();
  useEffect(() => {
    const onKey = dialogKeys(() => onSubmit?.(), onClose);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onSubmit]);

  return (
    // The bottom padding folds in the safe area: on a notched phone the
    // footer row otherwise sits partly under the home indicator (#83)
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain px-5 pt-20 pb-[max(5rem,env(safe-area-inset-bottom))]">
      <button
        type="button"
        aria-label={t('Close')}
        onClick={onClose}
        className="fixed inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-label={title}
        className={`relative w-full ${width} rounded-card border border-line bg-surface p-5 shadow-xl`}
      >
        <h2 className="eyebrow mb-4">{title}</h2>
        {children}
        <div className="mt-5 flex items-center justify-end gap-3">{footer}</div>
      </div>
    </div>
  );
}

export const dialogField =
  'w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent';
export const dialogLabel = 'mb-1.5 block text-sm font-medium text-ink';
export const dialogPrimary =
  'rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';
export const dialogGhost = 'px-2 py-2 text-sm text-muted hover:text-ink';
export const dialogDanger =
  'rounded-lg border border-urgent px-4 py-2 text-sm font-medium text-urgent hover:bg-urgent/10';

/*
  A destructive action that sits inline, among other controls, rather than
  in a dialog's footer (#79).

  Which of the two to reach for is a question of position, not of severity:
  `dialogDanger` is the bordered button that ends a dialog, where it is the
  primary thing on the row. `inlineDanger` is for a delete that lives next
  to unrelated controls — beside the toggles in the note header, in a row
  of devices, under a list — where a bordered button would shout over its
  neighbours. Both mean "this cannot be undone"; they differ in how much
  room they are allowed to take.

  Deliberately carries no font size. Call sites are `text-sm` in some rows
  and `text-xs` in compact ones, and baking a size in here would silently
  resize half of them — layout stays at the call site, the same way
  `ml-auto` and `shrink-0` already do.
*/
export const inlineDanger = 'text-muted underline underline-offset-2 hover:text-urgent';

// ── Context ───────────────────────────────────────────────────────────────

interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface DialogApi {
  prompt: (options: PromptOptions) => Promise<string | null>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const DialogContext = createContext<DialogApi | null>(null);

type Pending =
  | { kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.value ?? '');
        setPending({ kind: 'prompt', options, resolve });
      }),
    [],
  );

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ kind: 'confirm', options, resolve })),
    [],
  );

  useEffect(() => {
    if (pending?.kind === 'prompt') {
      // Select the whole value: the field is almost always rewritten, not appended to
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [pending]);

  function close(result: string | null | boolean) {
    if (!pending) return;
    if (pending.kind === 'prompt') pending.resolve(result as string | null);
    else pending.resolve(Boolean(result));
    setPending(null);
  }

  return (
    <DialogContext.Provider value={{ prompt, confirm }}>
      {children}

      {pending?.kind === 'prompt' && (
        <Modal
          title={pending.options.title}
          onClose={() => close(null)}
          onSubmit={() => close(value.trim() || null)}
          footer={
            <>
              <button type="button" onClick={() => close(null)} className={dialogGhost}>
                {t('Cancel')}
              </button>
              <button
                type="button"
                onClick={() => close(value.trim() || null)}
                className={dialogPrimary}
              >
                {pending.options.confirmLabel ?? t('Done')}
              </button>
            </>
          }
        >
          <label className="block">
            {pending.options.label && <span className={dialogLabel}>{pending.options.label}</span>}
            <input
              ref={inputRef}
              autoFocus
              value={value}
              placeholder={pending.options.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onBlur={clearBlankOnBlur(() => setValue(''))}
              onKeyDown={onEnter(() => close(value.trim() || null))}
              className={dialogField}
            />
          </label>
        </Modal>
      )}

      {pending?.kind === 'confirm' && (
        <Modal
          title={pending.options.title}
          onClose={() => close(false)}
          onSubmit={() => close(true)}
          footer={
            <>
              <button type="button" onClick={() => close(false)} className={dialogGhost}>
                {t('Cancel')}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => close(true)}
                className={pending.options.danger ? dialogDanger : dialogPrimary}
              >
                {pending.options.confirmLabel ?? t('Confirm')}
              </button>
            </>
          }
        >
          {pending.options.message && (
            <p className="text-sm text-muted">{pending.options.message}</p>
          )}
        </Modal>
      )}
    </DialogContext.Provider>
  );
}

export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error(t('useDialogs called outside DialogProvider'));
  return ctx;
}

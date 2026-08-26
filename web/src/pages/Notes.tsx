import { intlLocale, t } from '../lib/i18n';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { onEnter } from '../lib/keys';
import { clearBlankOnBlur } from '../lib/forms';
import { formatStamp } from '../lib/format';
import { useLatest } from '../lib/latest';
import { Empty, Page } from '../components/Page';
import { Editor, type UploadedFile } from '../components/Editor';
import { EntityDialog } from '../components/EntityDialog';
import { inlineDanger, useDialogs } from '../components/Dialog';

interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
}

interface NoteStub {
  id: string;
  title: string;
  folder_id: string | null;
  visibility: 'shared' | 'private';
  owner_id: string | null;
  owner_name: string | null;
  pinned: number;
  daily_date: string | null;
  is_template: number;
  updated_at: string;
  excerpt: string;
}

interface NoteLink {
  target_title: string;
  target_note_id: string | null;
  exists_now: number;
}

interface Note extends NoteStub {
  body_md: string;
  outgoing: NoteLink[];
  backlinks: { id: string; title: string }[];
  attachments: Attachment[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return t('{n} B', { n: bytes });
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ${t('KB')}`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ${t('MB')}`;
}

interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  is_image: number;
  created_at: string;
}

interface Version {
  id: string;
  title: string;
  created_at: string;
  author_name: string | null;
  size: number;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const chip = 'rounded-full border px-3 py-1.5 text-sm transition-colors';
const chipOn = 'border-accent bg-accent-soft text-accent';
const chipOff = 'border-line text-muted hover:text-ink';

export function Notes() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const dialogs = useDialogs();
  const isLatest = useLatest();
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteStub[] | null>(null);
  const [templates, setTemplates] = useState<NoteStub[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [folderId, setFolderId] = useState('');
  const [query, setQuery] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Unsaved edits are stored together with the note id.
  // Otherwise on a quick switch the debounced save lands on whichever
  // note is open now, overwriting it with someone else's text.
  const pending = useRef<{ noteId: string; patch: { title?: string; body_md?: string } } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef<Note | null>(null);
  noteRef.current = note;
  // flush is declared below openNote, so it is reached through a ref
  const flushRef = useRef<() => Promise<void>>(async () => {});

  const inTemplates = folderId === 'templates';

  const loadNotes = useCallback(async () => {
    const params = new URLSearchParams();
    if (folderId === 'templates') params.set('templates', 'true');
    else if (folderId) params.set('folder_id', folderId);
    if (query.trim()) params.set('q', query.trim());

    // Search fires a request on every keystroke; without this check the
    // response for «до» can arrive after the one for «докум» and clobber
    // the results
    const fresh = isLatest();
    const rows = await api.get<NoteStub[]>(`/notes?${params}`);
    if (!fresh()) return;
    setNotes(rows);
  }, [folderId, query, isLatest]);

  const loadTemplates = useCallback(async () => {
    setTemplates(await api.get<NoteStub[]>('/notes?templates=true'));
  }, []);

  useEffect(() => {
    void api.get<Folder[]>('/folders').then(setFolders);
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);


  const openNote = useCallback(async (noteId: string) => {
    // Leaving a note, write out whatever has not been saved yet
    if (pending.current) {
      if (timer.current) clearTimeout(timer.current);
      await flushRef.current();
    }
    setVersions(null);
    setSaveState('idle');
    try {
      setNote(await api.get<Note>(`/notes/${noteId}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not open the note'));
    }
  }, []);
  // Arriving from global search: /notes?open=<id>.
  // From the quick-actions screen: /notes?new=1 — a new note right away.
  useEffect(() => {
    const target = params.get('open');
    const wantNew = params.get('new');
    if (!target && !wantNew) return;
    if (target) void openNote(target);
    else void createNote();
    setParams({}, { replace: true });
    // createNote is a function declaration below and therefore in scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, openNote, setParams]);

  // ── Autosave ────────────────────────────────────────────────────────────

  const flush = useCallback(async () => {
    const entry = pending.current;
    if (!entry || Object.keys(entry.patch).length === 0) return;
    pending.current = null;
    setSaveState('saving');
    try {
      await api.patch(`/notes/${entry.noteId}`, entry.patch);
      setSaveState('saved');
      void loadNotes();

      // Links are recomputed on the server on every save, so the
      // connections panel must be refreshed — otherwise it shows the
      // state as of when the note was opened. Body and title stay
      // untouched: the person keeps typing, and overwriting them would
      // reset the cursor.
      const fresh = await api.get<Note>(`/notes/${entry.noteId}`);
      setNote((prev) =>
        prev && prev.id === fresh.id
          ? { ...prev, outgoing: fresh.outgoing, backlinks: fresh.backlinks }
          : prev,
      );
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : t('Could not save'));
    }
  }, [loadNotes]);

  flushRef.current = flush;

  const queueSave = useCallback(
    (patch: { title?: string; body_md?: string }) => {
      const current = noteRef.current;
      if (!current) return;

      // Anything accumulated for a different note is written immediately
      if (pending.current && pending.current.noteId !== current.id) void flush();

      pending.current = {
        noteId: current.id,
        patch: {
          ...(pending.current?.noteId === current.id ? pending.current.patch : {}),
          ...patch,
        },
      };
      setSaveState('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 1500);
    },
    [flush],
  );

  // Unfinished text must not be lost when the tab closes or the page is left
  useEffect(() => {
    const onLeave = () => {
      if (pending.current) void flush();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      onLeave();
    };
  }, [flush]);

  // ── Actions ─────────────────────────────────────────────────────────────

  async function createNote(templateId?: string) {
    const created = await api.post<Note>('/notes', {
      // No title is sent when creating from a template: the server takes
      // it from the template and expands the substitutions. An explicit
      // title would override them.
      ...(templateId ? {} : { title: inTemplates ? t('New template') : t('Untitled') }),
      folder_id:
        folderId && folderId !== 'none' && folderId !== 'templates' ? folderId : null,
      ...(inTemplates ? { is_template: true } : {}),
      // The locale rides along only where placeholders expand — the server
      // formats {{date}}/{{time}} in the interface language (#47)
      ...(templateId ? { template_id: templateId, locale: intlLocale } : {}),
    });
    await loadNotes();
    if (inTemplates) await loadTemplates();
    await openNote(created.id);
  }

  /** Turn a note into a template and back. */
  async function toggleTemplate() {
    if (!note) return;
    const next = !note.is_template;
    await api.patch(`/notes/${note.id}`, { is_template: next });
    setNote({ ...note, is_template: next ? 1 : 0 });
    await loadNotes();
    await loadTemplates();
  }

  const reloadFolders = useCallback(async () => {
    setFolders(await api.get<Folder[]>('/folders'));
  }, []);

  async function togglePrivate() {
    if (!note) return;
    const next = note.visibility === 'private' ? 'shared' : 'private';
    try {
      await api.patch(`/notes/${note.id}`, { visibility: next });
      await openNote(note.id);
      await loadNotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not change access'));
    }
  }

  async function removeNote() {
    if (!note) return;
    const ok = await dialogs.confirm({
      title: t('Delete note'),
      message: t('“{title}” and its attachments will be deleted permanently.', { title: note.title }),
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/notes/${note.id}`);
    setNote(null);
    await loadNotes();
  }

  /** Following a [[link]]: if the note does not exist, offer to create it. */
  const navigateByTitle = useCallback(
    async (title: string) => {
      const found = await api.get<NoteStub[]>(`/notes?q=${encodeURIComponent(title)}`);
      const exact = found.find((n) => n.title.toLowerCase() === title.toLowerCase());
      if (exact) {
        await openNote(exact.id);
        return;
      }
      const ok = await dialogs.confirm({
        title: t('No note yet'),
        message: t('“{title}” does not exist yet. Create it now?', { title }),
        confirmLabel: t('Create'),
      });
      if (ok) {
        const created = await api.post<Note>('/notes', { title });
        await loadNotes();
        await openNote(created.id);
      }
    },
    [openNote, loadNotes, dialogs],
  );

  /** Upload files attached to the current note. */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<UploadedFile[]> => {
      const current = noteRef.current;
      if (!current) return [];

      const form = new FormData();
      for (const file of files) form.append('file', file);

      const res = await fetch(`/api/notes/${current.id}/attachments`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? t('Could not upload the file'));
        return [];
      }

      const { uploaded } = (await res.json()) as { uploaded: UploadedFile[] };
      const fresh = await api.get<Note>(`/notes/${current.id}`);
      setNote((prev) => (prev && prev.id === fresh.id ? { ...prev, attachments: fresh.attachments } : prev));
      return uploaded;
    },
    [],
  );

  async function removeAttachment(attachment: Attachment) {
    if (!note) return;
    const ok = await dialogs.confirm({
      title: t('Delete file'),
      message: attachment.filename,
      confirmLabel: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/attachments/${attachment.id}`);
    setNote({ ...note, attachments: note.attachments.filter((a) => a.id !== attachment.id) });
  }

  async function showVersions() {
    if (!note) return;
    if (versions) {
      setVersions(null);
      return;
    }
    setVersions(await api.get<Version[]>(`/notes/${note.id}/versions`));
  }

  async function restore(versionId: string) {
    if (!note) return;
    const ok = await dialogs.confirm({
      title: t('Restore version'),
      message: t('The current state stays in history; the rollback can be undone.'),
      confirmLabel: t('Restore'),
    });
    if (!ok) return;
    // The pending save holds the text from BEFORE the rollback — it must
    // be discarded, or it would bring the undone edit right back
    pending.current = null;
    if (timer.current) clearTimeout(timer.current);

    await api.post(`/notes/${note.id}/restore/${versionId}`, {});
    await openNote(note.id);
    setRevision((r) => r + 1);
  }

  const saveLabel = useMemo(
    () => ({ idle: '', saving: t('Saving…'), saved: t('Saved'), error: t('Not saved') })[saveState],
    [saveState],
  );

  const isOwner = !note?.owner_id || note.owner_id === user?.id;

  return (
    <Page
      title={t('Notes')}
      eyebrow={t('Things to remember')}
      action={
        <div className="flex gap-2">
          {/* The "Today" daily-note button lived here; removed in #77 —
              the label read as a filter, the household does not use daily
              notes, and it looked like a duplicate of the Day template
              chip. The daily_date machinery stays in the schema, dormant. */}
          <button
            type="button"
            onClick={() => void createNote()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            {t('New')}
          </button>
        </div>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFolderId('')}
          className={`${chip} ${folderId === '' ? chipOn : chipOff}`}
        >
          {t('All')}
        </button>
        {folders.map((f) => (
          <span
            key={f.id}
            className={`${chip} flex items-center gap-2 ${folderId === f.id ? chipOn : chipOff}`}
          >
            <button type="button" onClick={() => setFolderId(f.id)} className="hover:text-ink">
              {f.name}
            </button>
            {folderId === f.id && (
              <button
                type="button"
                onClick={() => setEditingFolder(f)}
                aria-label={t('Configure folder {name}', { name: f.name })}
                className="opacity-60 hover:opacity-100"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 4v2M12 18v2M20 12h-2M6 12H4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4M17.7 17.7l-1.4-1.4M7.7 7.7 6.3 6.3" />
                </svg>
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setCreatingFolder(true)}
          className={`${chip} border-dashed border-line text-muted hover:text-ink`}
        >
          {t('+ folder')}
        </button>

        <button
          type="button"
          onClick={() => {
            setFolderId(inTemplates ? '' : 'templates');
            setNote(null);
          }}
          className={`${chip} ml-auto ${inTemplates ? chipOn : chipOff}`}
        >
          {t('Templates')}
        </button>
      </div>

      {error && (
        <p className="mb-4 rounded-lg border border-urgent bg-urgent/10 px-4 py-2.5 text-sm text-ink">
          {error}
        </p>
      )}

      {/* minmax(0,…) in the base column too: grid items default to
          min-width:auto, and without the zero the nowrap note previews
          dictated the column width — on phones the list pushed the page
          into a horizontal scroll */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[20rem_minmax(0,1fr)] 2xl:grid-cols-[22rem_minmax(0,1fr)_20rem] 3xl:gap-6">
        <div className={note ? 'hidden lg:block' : ''}>
          <input
            value={query}
            placeholder={t('Search notes')}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={clearBlankOnBlur(() => setQuery(''))}
            className="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />

          {notes === null ? (
            <div className="h-40 animate-pulse rounded-card bg-surface-3" />
          ) : notes.length === 0 ? (
            <Empty>{t('No notes. Start with the “New” button.')}</Empty>
          ) : (
            <ul className="overflow-hidden rounded-card border border-line bg-surface">
              {notes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => void openNote(n.id)}
                    className={`w-full border-b border-line px-4 py-3 text-left last:border-0 ${
                      note?.id === n.id ? 'bg-accent-soft' : 'hover:bg-surface-2'
                    }`}
                  >
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-ink">
                      {n.visibility === 'private' && (
                        <span className="text-muted" title={t('Private')}>
                          ●
                        </span>
                      )}
                      {n.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted">{n.excerpt || t('Empty')}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {templates.length > 0 && !inTemplates && (
            <div className="mt-4">
              <p className="eyebrow mb-2">{t('From template')}</p>
              <div className="flex flex-wrap gap-2">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => void createNote(t.id)}
                    className={`${chip} ${chipOff}`}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {note ? (
          /* Width is capped on the whole column, not on the text inside
             the card: otherwise the toolbar starts at the left edge while
             the text line sits somewhere in the middle, which reads as
             breakage. 52rem gives about 95 characters per line — the
             upper bound of readable. */
          <div className="w-full max-w-[52rem]">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setNote(null)}
                className="text-sm text-muted hover:text-ink lg:hidden"
              >
                {t('← List')}
              </button>

              <input
                key={note.id}
                defaultValue={note.title}
                onChange={(e) => queueSave({ title: e.target.value })}
                onBlur={clearBlankOnBlur(() => queueSave({ title: '' }))}
                onKeyDown={onEnter(() => void flush())}
                className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1.5 font-display text-lg font-semibold text-ink outline-none focus:border-line"
              />

              <span className="font-mono text-xs text-muted">{saveLabel}</span>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <select
                value={note.folder_id ?? ''}
                onChange={(e) => {
                  const next = e.target.value || null;
                  setNote({ ...note, folder_id: next });
                  void api.patch(`/notes/${note.id}`, { folder_id: next }).then(() => loadNotes());
                }}
                className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">{t('No folder')}</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => void togglePrivate()}
                disabled={!isOwner}
                title={
                  isOwner
                    ? t('A private note is visible only to its owner')
                    : t('The note belongs to someone else')
                }
                className={`${chip} ${
                  note.visibility === 'private' ? chipOn : chipOff
                } disabled:opacity-40`}
              >
                {note.visibility === 'private' ? t('Private') : t('Shared with the family')}
              </button>

              <button
                type="button"
                onClick={() => void toggleTemplate()}
                title={t('Templates stay out of the main list and are offered when creating a note')}
                className={`${chip} ${note.is_template ? chipOn : chipOff}`}
              >
                {note.is_template ? t('Template') : t('Regular')}
              </button>

              <button
                type="button"
                onClick={() => void showVersions()}
                className={`${chip} ${chipOff}`}
              >
                {t('History')}
              </button>

              <button
                type="button"
                onClick={() => void removeNote()}
                className={`${inlineDanger} ml-auto text-sm`}
              >
                {t('Delete')}
              </button>
            </div>

            {versions && (
              <div className="mb-3 overflow-hidden rounded-card border border-line bg-surface">
                {versions.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted">
                    {t('History is empty — the note has not been edited since creation.')}
                  </p>
                ) : (
                  <ul>
                    {versions.map((v) => (
                      <li
                        key={v.id}
                        className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0"
                      >
                        <span className="font-mono text-xs text-muted">{formatStamp(v.created_at)}</span>
                        <span className="min-w-0 flex-1 truncate text-sm text-ink">{v.title}</span>
                        <span className="text-xs text-muted">{v.author_name}</span>
                        <button
                          type="button"
                          onClick={() => void restore(v.id)}
                          className="text-xs text-accent underline underline-offset-2"
                        >
                          {t('Restore')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {note.is_template === 1 && (
              <p className="mb-3 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-xs text-muted">
                {t('Placeholders expand when a note is created:')}{' '}
                <code className="font-mono text-ink">{t('{{date}}')}</code>,{' '}
                <code className="font-mono text-ink">{t('{{time}}')}</code>,{' '}
                <code className="font-mono text-ink">{t('{{author}}')}</code>,{' '}
                <code className="font-mono text-ink">{t('{{iso}}')}</code> — {t('date like 2026-08-02.')}
                {t('They work in the title too.')}
              </p>
            )}

            <Editor
              noteId={note.id}
              revision={revision}
              initialMarkdown={note.body_md}
              onChange={(markdown) => queueSave({ body_md: markdown })}
              onNavigate={(title) => void navigateByTitle(title)}
              onUpload={uploadFiles}
            />

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink">
                {t('Attach a file')}
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (files.length) void uploadFiles(files);
                  }}
                />
              </label>
              <span className="text-xs text-muted">
                {t('Drag files into the text or paste from the clipboard')}
              </span>
            </div>

            {note.attachments.length > 0 && (
              <ul className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
                {note.attachments.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0"
                  >
                    {a.is_image ? (
                      <img
                        src={`/api/attachments/${a.id}`}
                        alt=""
                        className="size-9 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="grid size-9 shrink-0 place-items-center rounded bg-surface-2 font-mono text-[0.625rem] text-muted uppercase">
                        {(a.filename.split('.').pop() ?? t('file')).slice(0, 4)}
                      </span>
                    )}

                    <a
                      href={`/api/attachments/${a.id}?download=true`}
                      className="min-w-0 flex-1 truncate text-sm text-ink hover:text-accent"
                    >
                      {a.filename}
                    </a>

                    <span className="font-mono text-xs text-muted">
                      {formatBytes(a.size_bytes)}
                    </span>

                    <button
                      type="button"
                      onClick={() => void removeAttachment(a)}
                      className={`${inlineDanger} text-xs`}
                    >
                      {t('Delete')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

          </div>
        ) : (
          <div className="hidden lg:block">
            <Empty>
              {t('Pick a note — or')}{' '}
              <button
                type="button"
                onClick={() => void createNote()}
                className="text-accent underline underline-offset-2"
              >
                {t('create a new one')}
              </button>
              .
            </Empty>
          </div>
        )}

        {note && (
          <aside className="lg:col-start-2 2xl:col-start-3 2xl:row-start-1">
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-1">
              {note.outgoing.length > 0 && (
                <section className="rounded-card border border-line bg-surface p-4">
                  <h3 className="eyebrow mb-2.5">{t('Links to')}</h3>
                  <ul className="space-y-1.5">
                    {note.outgoing.map((l) => (
                      <li key={l.target_title}>
                        <button
                          type="button"
                          onClick={() => void navigateByTitle(l.target_title)}
                          className={`text-left text-sm underline underline-offset-2 ${
                            l.exists_now ? 'text-accent' : 'text-muted'
                          }`}
                        >
                          {l.target_title}
                          {!l.exists_now && t(' — none yet')}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {note.backlinks.length > 0 && (
                <section className="rounded-card border border-line bg-surface p-4">
                  <h3 className="eyebrow mb-2.5">{t('Mentioned by')}</h3>
                  <ul className="space-y-1.5">
                    {note.backlinks.map((b) => (
                      <li key={b.id}>
                        <button
                          type="button"
                          onClick={() => void openNote(b.id)}
                          className="text-left text-sm text-accent underline underline-offset-2"
                        >
                          {b.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <p className="mt-4 text-xs text-muted">
              {t('Link to another note with double square brackets. Follow it with Cmd or Ctrl and a click.')}
            </p>
          </aside>
        )}
      </div>
      {creatingFolder && (
        <EntityDialog
          title={t('New folder')}
          initial={{ name: '' }}
          onSave={async (draft) => {
            await api.post('/folders', { name: draft.name });
            await reloadFolders();
          }}
          onClose={() => setCreatingFolder(false)}
        />
      )}

      {editingFolder && (
        <EntityDialog
          title={t('Folder')}
          initial={{ name: editingFolder.name }}
          deletable
          onSave={async (draft) => {
            await api.patch(`/folders/${editingFolder.id}`, { name: draft.name });
            await reloadFolders();
          }}
          onDelete={async () => {
            await api.delete(`/folders/${editingFolder.id}`);
            await reloadFolders();
            setFolderId('');
          }}
          onClose={() => setEditingFolder(null)}
        />
      )}
    </Page>
  );
}

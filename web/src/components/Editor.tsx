import { t } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';
import { WikiLink } from './WikiLink';

/**
 * The markdown serializer escapes square brackets, turning [[Link]]
 * into \[\[Link\]\]. Parsing back removes the escaping, so everything
 * looks fine in the editor — while what lands on disk is text where
 * the connection between notes can no longer be recognized.
 * We unescape exactly this case, leaving the rest of the markup alone.
 */
function unescapeWikiLinks(markdown: string): string {
  return markdown.replace(/\\\[\\\[([^\][|]{1,200})\\\]\\\]/g, '[[$1]]');
}

// tiptap-markdown puts the serializer in storage but ships no types of its own
declare module '@tiptap/core' {
  interface Storage {
    markdown: { getMarkdown: () => string };
  }
}

export interface UploadedFile {
  id: string;
  filename: string;
  is_image: boolean;
  url: string;
}

interface Props {
  /** Changes only when switching notes, not on every keystroke. */
  noteId: string;
  /**
   * Counter of external content replacements — e.g. reverting to a version.
   * The editor owns the document and never learns that initialMarkdown
   * changed, so it must be recreated explicitly. Without this a revert
   * looked successful on the server while the editor kept the old text —
   * and the next autosave wrote it back, undoing the revert.
   */
  revision?: number;
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onNavigate: (title: string) => void;
  onUpload: (files: File[]) => Promise<UploadedFile[]>;
  /** False on a device that cannot open the family key: reading is fine, typing would be lost. */
  editable?: boolean;
}

const btn =
  'rounded px-2 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-ink';
const btnActive = 'rounded px-2 py-1 text-sm bg-accent-soft text-accent';

export function Editor({ noteId, revision = 0, initialMarkdown, onChange, onNavigate, onUpload, editable = true }: Props) {
  const [dropping, setDropping] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef(onUpload);
  // Update the ref after render, not during it: writing to a ref in the
  // component body breaks React's assumptions about render purity. TipTap
  // handlers only need the ref on events, and the effect runs before those.
  useEffect(() => {
    uploadRef.current = onUpload;
  }, [onUpload]);
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: { openOnClick: false },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit.configure({ table: { resizable: false } }),
        Highlight,
        Placeholder.configure({ placeholder: t('Start writing. [[Link]] connects notes') }),
        // Lazy loading: a decoded photo takes megabytes of tab memory
        // regardless of file size. In a long note full of photos, let
        // the ones on screen decode rather than all of them at once.
        Image.configure({
          inline: false,
          HTMLAttributes: { loading: 'lazy', decoding: 'async' },
        }),
        Markdown.configure({ html: false, breaks: true, transformPastedText: true }),
        WikiLink.configure({ onNavigate }),
      ],
      content: initialMarkdown,
      editable,
      editorProps: {
        attributes: { class: 'note-content' },

        // Drag-and-drop of files into the text. Images land at the drop
        // point, other files simply get attached to the note.
        handleDrop(view, event, _slice, moved) {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (moved || files.length === 0) return false;
          event.preventDefault();
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void handleFiles(files, at);
          return true;
        },

        handlePaste(_view, event) {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void handleFiles(files);
          return true;
        },
      },
      onUpdate({ editor }) {
        onChange(unescapeWikiLinks(editor.storage.markdown.getMarkdown()));
      },
    },
    // Recreate the editor when the note changes: no manual content sync
    // needed, and it's impossible to accidentally write text into the wrong note.
    [noteId, revision, editable],
  );

  async function handleFiles(files: File[], at?: number) {
    setUploading(true);
    try {
      const uploaded = await uploadRef.current(files);
      const images = uploaded.filter((f) => f.is_image);
      if (images.length > 0 && editor) {
        const chain = editor.chain().focus();
        if (at !== undefined) chain.setTextSelection(at);
        for (const image of images) {
          chain.setImage({ src: image.url, alt: image.filename });
        }
        chain.run();
      }
    } finally {
      setUploading(false);
      setDropping(false);
    }
  }

  useEffect(() => {
    return () => editor?.destroy();
  }, [editor]);

  if (!editor) return <div className="h-64 animate-pulse rounded-card bg-surface-3" />;

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={() => setDropping(false)}
      className={`relative rounded-card border bg-surface transition-colors ${
        dropping ? 'border-accent' : 'border-line'
      }`}
    >
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />

      {(dropping || uploading) && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-card bg-surface/80">
          <p className="rounded-lg border border-accent bg-surface px-4 py-2 text-sm text-ink">
            {uploading ? t('Loading…') : t('Release — the file will attach to the note')}
          </p>
        </div>
      )}
    </div>
  );
}

function Toolbar({ editor }: { editor: TiptapEditor }) {
  const cls = (active: boolean) => (active ? btnActive : btn);

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-2 py-1.5">
      {([1, 2, 3] as const).map((level) => (
        <button
          key={level}
          type="button"
          onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          className={cls(editor.isActive('heading', { level }))}
          title={t('Heading {level}', { level })}
        >
          H{level}
        </button>
      ))}

      <span className="mx-1 h-4 w-px bg-line" aria-hidden />

      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={cls(editor.isActive('bold'))}
        title={t('Bold')}
      >
        <b>{t('B')}</b>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={cls(editor.isActive('italic'))}
        title={t('Italic')}
      >
        <i>{t('I')}</i>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        className={cls(editor.isActive('highlight'))}
        title={t('Highlight')}
      >
        <span className="bg-[#f4e08a] px-0.5 text-[#131c24]">{t('H')}</span>
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={cls(editor.isActive('code'))}
        title={t('Code')}
      >
        <span className="font-mono">{'</>'}</span>
      </button>

      <span className="mx-1 h-4 w-px bg-line" aria-hidden />

      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={cls(editor.isActive('bulletList'))}
        title={t('List')}
      >
        •
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={cls(editor.isActive('orderedList'))}
        title={t('Numbered list')}
      >
        1.
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        className={cls(editor.isActive('taskList'))}
        title={t('Checklist')}
      >
        ☑
      </button>
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={cls(editor.isActive('blockquote'))}
        title={t('Quote')}
      >
        ❝
      </button>
      <button
        type="button"
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        className={btn}
        title={t('Table')}
      >
        ▦
      </button>

      <span className="mx-1 h-4 w-px bg-line" aria-hidden />

      <button
        type="button"
        onClick={() => editor.chain().focus().insertContent('[[]]').run()}
        className={btn}
        title={t('Link to a note')}
      >
        [[ ]]
      </button>
    </div>
  );
}

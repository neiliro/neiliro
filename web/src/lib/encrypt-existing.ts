import { api } from './api';
import { pendingPlaintext } from './codec';
import { invalidateSearchCorpus } from './search';

/*
  The one-time job that brings a family's old notes under the key (#215).

  Notes written before the family key existed sit on the server as
  plaintext. The server cannot encrypt them — that is the whole point — so
  a browser holding the key reads each one and writes it back; lib/api.ts
  seals the write like any other. Versions go the same way, each one
  rewritten with its own ciphertext, so history stays readable afterwards.

  The job sees what this person sees: shared notes and their own private
  ones. Another member's private notes wait for that member to run it.
  Re-running is harmless — an already encrypted row is not on the list.
*/

export interface EncryptProgress {
  total: number;
  done: number;
  failed: number;
}

interface NoteBody {
  id: string;
  title: string;
  body_md: string;
}

interface VersionRow {
  id: string;
}

export async function encryptExistingNotes(
  onProgress: (p: EncryptProgress) => void,
): Promise<EncryptProgress> {
  // Walking the lists lets the codec register which rows arrived plaintext
  await api.get<unknown[]>('/notes?limit=2000');
  await api.get<unknown[]>('/notes?templates=true&limit=2000');
  const ids = pendingPlaintext('notes');
  const progress: EncryptProgress = { total: ids.length, done: 0, failed: 0 };
  onProgress({ ...progress });

  for (const id of ids) {
    try {
      const note = await api.get<NoteBody>(`/notes/${id}`);
      // The note first: the server keeps a version of the old body on
      // change, and that version is caught by the pass below
      await api.patch(`/notes/${id}`, { title: note.title, body_md: note.body_md });
      await api.get<VersionRow[]>(`/notes/${id}/versions?limit=1000`);
      for (const key of pendingPlaintext('note_versions')) {
        const [noteId, versionId] = key.split('/');
        if (noteId !== id) continue;
        const version = await api.get<NoteBody>(`/notes/${id}/versions/${versionId}`);
        await api.patch(`/notes/${id}/versions/${versionId}`, {
          title: version.title,
          body_md: version.body_md,
        });
      }
      progress.done += 1;
    } catch {
      progress.failed += 1;
    }
    onProgress({ ...progress });
  }
  invalidateSearchCorpus();
  return progress;
}

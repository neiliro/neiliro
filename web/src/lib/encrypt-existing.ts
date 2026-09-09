import { api } from './api';
import { pendingPlaintext } from './codec';
import { invalidateSearchCorpus } from './search';

/*
  The one-time job that brings a family's old rows under the key (#215,
  #217, and each module after it).

  Rows written before the family key existed sit on the server as
  plaintext. The server cannot encrypt them — that is the whole point — so
  a browser holding the key reads each one and writes it back; lib/api.ts
  seals the write like any other. Note versions go the same way, each one
  rewritten with its own ciphertext, so history stays readable afterwards.

  The job sees what this person sees: shared rows and their own private
  ones. Another member's private notes wait for that member to run it.
  Re-running is harmless — an already encrypted row is not on the list.
*/

export interface EncryptProgress {
  total: number;
  done: number;
  failed: number;
}

interface TextRow {
  id: string;
  title: string;
  description?: string | null;
  body_md?: string;
  location?: string | null;
  name?: string;
  profile_user_id?: string | null;
}

/** One table: how to see all its rows, and which fields to write back. */
interface Module {
  table: string;
  lists: string[];
  rewrite: (id: string) => Promise<void>;
}

const MODULES: Module[] = [
  {
    table: 'notes',
    lists: ['/notes?limit=2000', '/notes?templates=true&limit=2000'],
    rewrite: async (id) => {
      const note = await api.get<TextRow>(`/notes/${id}`);
      // The note first: the server keeps a version of the old body on
      // change, and that version is caught by the pass below
      await api.patch(`/notes/${id}`, { title: note.title, body_md: note.body_md });
      await api.get<unknown[]>(`/notes/${id}/versions?limit=1000`);
      for (const key of pendingPlaintext('note_versions')) {
        const [noteId, versionId] = key.split('/');
        if (noteId !== id) continue;
        const version = await api.get<TextRow>(`/notes/${id}/versions/${versionId}`);
        await api.patch(`/notes/${id}/versions/${versionId}`, { title: version.title, body_md: version.body_md });
      }
    },
  },
  {
    table: 'projects',
    lists: ['/projects', '/projects?archived=true'],
    rewrite: async (id) => {
      const rows = await api.get<TextRow[]>('/projects');
      const archived = await api.get<TextRow[]>('/projects?archived=true');
      const project = [...rows, ...archived].find((p) => p.id === id);
      if (project) await api.patch(`/projects/${id}`, { title: project.title, description: project.description ?? null });
    },
  },
  {
    table: 'tasks',
    lists: ['/tasks?include_done=true&limit=2000'],
    rewrite: async (id) => {
      const task = await api.get<TextRow>(`/tasks/${id}`);
      await api.patch(`/tasks/${id}`, { title: task.title, description: task.description ?? null });
    },
  },
  {
    table: 'calendars',
    lists: ['/calendars'],
    rewrite: async (id) => {
      const calendar = (await api.get<TextRow[]>('/calendars')).find((c) => c.id === id);
      if (calendar?.name) await api.patch(`/calendars/${id}`, { name: calendar.name });
    },
  },
  {
    // The search corpus is the one list of every event this person may see
    table: 'events',
    lists: ['/search/corpus'],
    rewrite: async (id) => {
      const event = await api.get<TextRow>(`/events/${id}`);
      // A birthday is derived from a profile and re-made on every profile
      // save, with the member's name — plaintext by design, not a leftover
      if (event.profile_user_id) return;
      await api.patch(`/events/${id}`, {
        title: event.title,
        description: event.description ?? null,
        location: event.location ?? null,
      });
    },
  },
];

export async function encryptExisting(onProgress: (p: EncryptProgress) => void): Promise<EncryptProgress> {
  // Walking the lists lets the codec register which rows arrived plaintext
  const work: { module: Module; id: string }[] = [];
  for (const module of MODULES) {
    for (const list of module.lists) await api.get<unknown[]>(list);
    for (const id of pendingPlaintext(module.table)) work.push({ module, id });
  }
  const progress: EncryptProgress = { total: work.length, done: 0, failed: 0 };
  onProgress({ ...progress });

  for (const { module, id } of work) {
    try {
      await module.rewrite(id);
      progress.done += 1;
    } catch {
      progress.failed += 1;
    }
    onProgress({ ...progress });
  }
  invalidateSearchCorpus();
  return progress;
}

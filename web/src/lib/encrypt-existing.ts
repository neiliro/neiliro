import { api, ApiError } from './api';
import { pendingPlaintext } from './codec';
import { encryptExistingAttachment } from './files';
import { invalidateSearchCorpus } from './search';

/*
  The one-time job that brings a family's old rows under the key (#215 and
  each module after it).

  Rows written before the family key existed sit on the server as
  plaintext. The server cannot encrypt them — that is the whole point — so
  a browser holding the key reads each one and writes it back; lib/api.ts
  seals the write like any other. Note versions go the same way, each one
  rewritten with its own ciphertext, so history stays readable afterwards.

  Every list the job walks passes through the codec, which notes the rows
  that arrived plaintext; the job then rewrites exactly those. It sees what
  this person sees: shared rows and their own private ones. Another
  member's private notes wait for that member to run it. Re-running is
  harmless — an already encrypted row is not on the list.
*/

export interface EncryptProgress {
  total: number;
  done: number;
  failed: number;
}

type Row = Record<string, unknown>;

/** One table: how to see every row this person may, and how to write one back. */
interface Module {
  table: string;
  collect: () => Promise<Map<string, Row>>;
  rewrite: (id: string, row: Row) => Promise<void>;
}

const byId = (rows: Row[], into = new Map<string, Row>()) => {
  for (const row of rows) if (typeof row['id'] === 'string') into.set(row['id'], row);
  return into;
};

const pick = (row: Row, fields: string[]): Row =>
  Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));

/** Transactions are capped per request; walk backwards by date until a page comes up short. */
async function allTransactions(): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  let to = '';
  for (let page = 0; page < 200; page += 1) {
    const rows: Row[] = await api.get<Row[]>(`/transactions?limit=500${to ? `&to=${to}` : ''}`);
    byId(rows, out);
    if (rows.length < 500) break;
    let oldest = '9999-12-31';
    for (const r of rows) if (String(r['occurred_on']) < oldest) oldest = String(r['occurred_on']);
    // Same-day rows beyond the cap are revisited by the next window; harmless
    const prev = new Date(`${oldest}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    to = prev.toISOString().slice(0, 10);
  }
  return out;
}

const MODULES: Module[] = [
  {
    table: 'notes',
    collect: async () => byId([...(await api.get<Row[]>('/notes?limit=2000')), ...(await api.get<Row[]>('/notes?templates=true&limit=2000'))]),
    rewrite: async (id) => {
      const note = await api.get<Row>(`/notes/${id}`);
      // The note first: the server keeps a version of the old body on
      // change, and that version is caught by the pass below
      await api.patch(`/notes/${id}`, pick(note, ['title', 'body_md']));
      await api.get<unknown[]>(`/notes/${id}/versions?limit=1000`);
      for (const key of pendingPlaintext('note_versions')) {
        const [noteId, versionId] = key.split('/');
        if (noteId !== id) continue;
        const version = await api.get<Row>(`/notes/${id}/versions/${versionId}`);
        await api.patch(`/notes/${id}/versions/${versionId}`, pick(version, ['title', 'body_md']));
      }
    },
  },
  {
    table: 'projects',
    collect: async () => byId([...(await api.get<Row[]>('/projects')), ...(await api.get<Row[]>('/projects?archived=true'))]),
    rewrite: (id, row) => api.patch(`/projects/${id}`, pick(row, ['title', 'description'])),
  },
  {
    table: 'tasks',
    collect: async () => byId(await api.get<Row[]>('/tasks?include_done=true&limit=2000')),
    rewrite: (id, row) => api.patch(`/tasks/${id}`, pick(row, ['title', 'description'])),
  },
  {
    table: 'calendars',
    collect: async () => byId(await api.get<Row[]>('/calendars')),
    rewrite: (id, row) => api.patch(`/calendars/${id}`, pick(row, ['name'])),
  },
  {
    // The search corpus is the one list of every event this person may see
    table: 'events',
    collect: async () => byId((await api.get<{ events: Row[] }>('/search/corpus')).events),
    rewrite: async (id) => {
      const event = await api.get<Row>(`/events/${id}`);
      // A birthday is derived from a profile and re-made on every profile
      // save, with the member's name — plaintext by design, not a leftover
      if (event['profile_user_id']) return;
      await api.patch(`/events/${id}`, pick(event, ['title', 'description', 'location']));
    },
  },
  {
    table: 'accounts',
    collect: async () => byId([...(await api.get<Row[]>('/accounts')), ...(await api.get<Row[]>('/accounts?archived=true'))]),
    rewrite: (id, row) => api.patch(`/accounts/${id}`, pick(row, ['name'])),
  },
  {
    table: 'categories',
    collect: async () => byId(await api.get<Row[]>('/categories')),
    rewrite: (id, row) => api.patch(`/categories/${id}`, pick(row, ['name'])),
  },
  {
    table: 'recurring_transactions',
    collect: async () => byId(await api.get<Row[]>('/recurring')),
    rewrite: (id, row) => api.patch(`/recurring/${id}`, pick(row, ['title', 'note', 'place'])),
  },
  {
    table: 'lists',
    collect: async () => byId(await api.get<Row[]>('/lists')),
    rewrite: (id, row) => api.patch(`/lists/${id}`, pick(row, ['title'])),
  },
  {
    // Items and sections come with their list; both registries fill as the lists are opened
    table: 'list_items',
    collect: async () => {
      const out = new Map<string, Row>();
      for (const list of await api.get<Row[]>('/lists')) {
        const full = await api.get<{ items: Row[]; sections: Row[] }>(`/lists/${String(list['id'])}`);
        byId(full.items, out);
      }
      return out;
    },
    rewrite: (id, row) => api.patch(`/list-items/${id}`, pick(row, ['title'])),
  },
  {
    table: 'list_sections',
    collect: async () => {
      const out = new Map<string, Row>();
      for (const list of await api.get<Row[]>('/lists')) {
        byId((await api.get<{ sections: Row[] }>(`/lists/${String(list['id'])}`)).sections, out);
      }
      return out;
    },
    rewrite: (id, row) => api.patch(`/list-sections/${id}`, pick(row, ['title'])),
  },
  {
    // Every member's entries are readable to the family, editable by the
    // member or the admin; a 403 on someone else's is a skip, not a failure
    table: 'profile_entries',
    collect: async () => {
      const out = new Map<string, Row>();
      for (const member of await api.get<Row[]>('/profiles')) {
        const profile = await api.get<{ entries: Row[] }>(`/profiles/${String(member['id'])}`);
        for (const entry of profile.entries) out.set(String(entry['id']), { ...entry, user_id: member['id'] });
      }
      return out;
    },
    rewrite: async (id, row) => {
      try {
        await api.patch(`/profiles/${String(row['user_id'])}/entries/${id}`, pick(row, ['label', 'value']));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 403)) throw err;
      }
    },
  },
  {
    // Files: fetched, sealed under their own id and put back in place. The
    // corpus is the one list of every attachment this person may see.
    table: 'attachments',
    collect: async () => byId((await api.get<{ attachments: Row[] }>('/search/corpus')).attachments.filter((a) => a['encryption'] === 0)),
    rewrite: (id, row) => encryptExistingAttachment(id, String(row['filename']), String(row['mime'] ?? '')),
  },
  {
    table: 'transactions',
    collect: allTransactions,
    rewrite: (id, row) => {
      // Words inherited from a rule are the rule's, not this row's, and the
      // codec already filled them in: write back only what the row holds
      const own = { note: row['recurring_note'] === row['note'] ? null : row['note'], place: row['recurring_place'] === row['place'] ? null : row['place'] };
      if (own.note === null && own.place === null) return Promise.resolve();
      return api.patch(`/transactions/${id}`, own);
    },
  },
];

export async function encryptExisting(onProgress: (p: EncryptProgress) => void): Promise<EncryptProgress> {
  const work: { module: Module; id: string; row: Row }[] = [];
  for (const module of MODULES) {
    const rows = await module.collect();
    for (const id of pendingPlaintext(module.table)) {
      const row = rows.get(id);
      if (row) work.push({ module, id, row });
    }
  }
  const progress: EncryptProgress = { total: work.length, done: 0, failed: 0 };
  onProgress({ ...progress });

  for (const { module, id, row } of work) {
    try {
      await module.rewrite(id, row);
      progress.done += 1;
    } catch {
      progress.failed += 1;
    }
    onProgress({ ...progress });
  }
  invalidateSearchCorpus();
  return progress;
}

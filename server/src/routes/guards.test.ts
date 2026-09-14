import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { id, now, runWithDb } from '../db/index.js';

/*
  The privacy promise, as a test.

  "Private" here is enforced by the server, per owner, with no exception
  for the administrator — it is the thing the README tells strangers on
  the internet, and the single most likely place to introduce a serious
  bug: a new route that takes an :id and forgets its visibility guard
  looks exactly like a correct one.

  The shape of every case is the same: Alice creates something private,
  Bob asks for it by id, and the answer must be 404 — not 200, and not
  403 either, which would confirm the thing exists.

  Both are administrators on purpose. The guard has no role exception, and
  a test between two ordinary members would miss exactly the backdoor the
  project promises not to have.
*/

let hub: Harness;
let aliceCookie = '';
let bobCookie = '';

const as = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  hub.as(cookie, method, url, payload);

beforeAll(async () => {
  hub = await buildTestApp();
  aliceCookie = hub.join('alice').cookie;
  bobCookie = hub.join('bob').cookie;
});

describe('a private note', () => {
  let noteId = '';

  beforeAll(async () => {
    const created = await as(aliceCookie, 'POST', '/api/notes', {
      title: 'Alice only',
      body_md: 'surprise party budget',
      visibility: 'private',
    });
    noteId = created.json<{ id: string }>().id;
    expect(created.statusCode).toBe(201);
  });

  it('is hers to read', async () => {
    expect((await as(aliceCookie, 'GET', `/api/notes/${noteId}`)).statusCode).toBe(200);
  });

  it('is not in his list', async () => {
    const list = (await as(bobCookie, 'GET', '/api/notes')).json<{ title: string }[]>();
    expect(list.map((n) => n.title)).not.toContain('Alice only');
  });

  it('is not his to read, edit or delete', async () => {
    expect((await as(bobCookie, 'GET', `/api/notes/${noteId}`)).statusCode).toBe(404);
    expect((await as(bobCookie, 'PATCH', `/api/notes/${noteId}`, { title: 'x' })).statusCode).toBe(404);
    expect((await as(bobCookie, 'DELETE', `/api/notes/${noteId}`)).statusCode).toBe(404);
  });

  it('is not in his search corpus', async () => {
    // Search moved to the browser (#226): the server no longer matches a
    // query, it only decides who may see which row. So the guard here is
    // that the corpus itself omits the note for Bob and carries it for
    // Alice — not that a query for its words comes up empty.
    const bobCorpus = (await as(bobCookie, 'GET', '/api/search/corpus')).json<{
      notes: { id: string }[];
    }>();
    expect(bobCorpus.notes.map((n) => n.id)).not.toContain(noteId);

    const aliceCorpus = (await as(aliceCookie, 'GET', '/api/search/corpus')).json<{
      notes: { id: string }[];
    }>();
    expect(aliceCorpus.notes.map((n) => n.id)).toContain(noteId);
  });

  it('has no readable version history', async () => {
    expect((await as(bobCookie, 'GET', `/api/notes/${noteId}/versions`)).statusCode).toBe(404);
  });
});

describe('a personal money account', () => {
  let accountId = '';

  beforeAll(async () => {
    const created = await as(aliceCookie, 'POST', '/api/accounts', {
      name: 'Alice personal',
      currency: 'EUR',
      opening_balance: 42000,
      shared: false,
    });
    accountId = created.json<{ id: string }>().id;
    expect(created.statusCode).toBe(201);
  });

  it('is not in his list', async () => {
    const list = (await as(bobCookie, 'GET', '/api/accounts')).json<{ name: string }[]>();
    expect(list.map((a) => a.name)).not.toContain('Alice personal');
  });

  it('is not his to edit, reconcile or delete', async () => {
    expect((await as(bobCookie, 'PATCH', `/api/accounts/${accountId}`, { name: 'x' })).statusCode).toBe(404);
    expect(
      (await as(bobCookie, 'POST', `/api/accounts/${accountId}/reconcile`, {
        actual_balance: 1,
        checked_on: '2026-08-19',
      })).statusCode,
    ).toBe(404);
    // The one the sweep was written for: delete had no guard at all, so an
    // empty account anyone knew the id of could be removed by anyone
    expect((await as(bobCookie, 'DELETE', `/api/accounts/${accountId}`)).statusCode).toBe(404);
  });

  it('survives his attempt', async () => {
    const list = (await as(aliceCookie, 'GET', '/api/accounts')).json<{ name: string }[]>();
    expect(list.map((a) => a.name)).toContain('Alice personal');
  });
});

describe('a personal calendar', () => {
  let calendarId = '';

  beforeAll(async () => {
    const created = await as(aliceCookie, 'POST', '/api/calendars', {
      name: 'Alice personal',
      shared: false,
    });
    calendarId = created.json<{ id: string }>().id;
    expect(created.statusCode).toBe(201);
  });

  it('is not in his list', async () => {
    const list = (await as(bobCookie, 'GET', '/api/calendars')).json<{ name: string }[]>();
    expect(list.map((c) => c.name)).not.toContain('Alice personal');
  });

  it('is not his to edit or delete', async () => {
    expect((await as(bobCookie, 'PATCH', `/api/calendars/${calendarId}`, { name: 'x' })).statusCode).toBe(404);
    expect((await as(bobCookie, 'DELETE', `/api/calendars/${calendarId}`)).statusCode).toBe(404);
  });
});

describe('an unauthenticated caller', () => {
  it('gets nowhere near any of it', async () => {
    for (const url of ['/api/notes', '/api/accounts', '/api/calendars', '/api/tasks']) {
      const res = await hub.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('a transaction on a personal account', () => {
  let txId = '';

  beforeAll(async () => {
    const account = (
      await as(aliceCookie, 'POST', '/api/accounts', {
        name: 'Alice wallet',
        currency: 'EUR',
        shared: false,
      })
    ).json<{ id: string }>().id;
    const created = await as(aliceCookie, 'POST', '/api/transactions', {
      account_id: account,
      kind: 'expense',
      amount: 12_34,
      occurred_on: '2026-08-14',
      note: 'a present',
    });
    txId = created.json<{ id: string }>().id;
    expect(created.statusCode).toBe(201);
  });

  it('is not in his list', async () => {
    const list = (await as(bobCookie, 'GET', '/api/transactions?from=2026-08-01&to=2026-08-31')).json<
      { id: string }[]
    >();
    expect(list.map((t) => t.id)).not.toContain(txId);
  });

  it('is not his to read, edit or delete', async () => {
    expect((await as(bobCookie, 'GET', `/api/transactions/${txId}/attachments`)).statusCode).toBe(404);
    expect((await as(bobCookie, 'PATCH', `/api/transactions/${txId}`, { amount: 1 })).statusCode).toBe(404);
    expect((await as(bobCookie, 'DELETE', `/api/transactions/${txId}`)).statusCode).toBe(404);
  });
});

describe('an attachment on a private note', () => {
  let attachmentId = '';

  beforeAll(async () => {
    const noteId = (
      await as(aliceCookie, 'POST', '/api/notes', { title: 'Sealed', visibility: 'private' })
    ).json<{ id: string }>().id;

    // Inserted rather than uploaded: the multipart path is not what is
    // under test here, the read guard is
    runWithDb(hub.db, () => {
      attachmentId = id();
      hub.db
        .prepare(
          `INSERT INTO attachments (id, filename, mime, size_bytes, storage_path, note_id, created_at)
           VALUES (?, 'secret.pdf', 'application/pdf', 10, '2026-08/x.pdf', ?, ?)`,
        )
        .run(attachmentId, noteId, now());
    });
  });

  it('is hers to fetch', async () => {
    // 404 from disk, not from the guard: the row exists, the file never did
    const res = await as(aliceCookie, 'GET', `/api/attachments/${attachmentId}`);
    expect(res.json<{ error: string }>().error).toBe('The file is missing on disk');
  });

  it('is not his to fetch or delete', async () => {
    const read = await as(bobCookie, 'GET', `/api/attachments/${attachmentId}`);
    expect(read.statusCode).toBe(404);
    expect(read.json<{ error: string }>().error).toBe('File not found');
    expect((await as(bobCookie, 'DELETE', `/api/attachments/${attachmentId}`)).statusCode).toBe(404);
  });

  it('does not surface in his search corpus', async () => {
    const bobCorpus = (await as(bobCookie, 'GET', '/api/search/corpus')).json<{
      attachments: { id: string }[];
    }>();
    expect(bobCorpus.attachments.map((a) => a.id)).not.toContain(attachmentId);

    const aliceCorpus = (await as(aliceCookie, 'GET', '/api/search/corpus')).json<{
      attachments: { id: string }[];
    }>();
    expect(aliceCorpus.attachments.map((a) => a.id)).toContain(attachmentId);
  });
});

describe('an event on a personal calendar', () => {
  let eventId = '';

  beforeAll(async () => {
    const calendarId = (
      await as(aliceCookie, 'POST', '/api/calendars', { name: 'Alice hours', shared: false })
    ).json<{ id: string }>().id;
    const created = await as(aliceCookie, 'POST', '/api/events', {
      title: 'Therapy',
      calendar_id: calendarId,
      starts_at: '2026-08-20T10:00',
      ends_at: '2026-08-20T11:00',
    });
    eventId = created.json<{ id: string }>().id;
    expect(created.statusCode).toBe(201);
  });

  it('is not in his range', async () => {
    const list = (await as(bobCookie, 'GET', '/api/events?from=2026-08-01&to=2026-08-31')).json<
      { title: string }[]
    >();
    expect(list.map((e) => e.title)).not.toContain('Therapy');
  });

  it('is not his to read, edit or delete', async () => {
    expect((await as(bobCookie, 'GET', `/api/events/${eventId}`)).statusCode).toBe(404);
    expect((await as(bobCookie, 'PATCH', `/api/events/${eventId}`, { title: 'x' })).statusCode).toBe(404);
    expect((await as(bobCookie, 'DELETE', `/api/events/${eventId}`)).statusCode).toBe(404);
  });
});

describe('a note expanded from a private template', () => {
  it('inherits the template privacy instead of publishing it (#50)', async () => {
    const created = await as(aliceCookie, 'POST', '/api/notes', {
      title: 'Gift planning',
      body_md: 'the thing we discussed',
      visibility: 'private',
      is_template: true,
    });
    const templateId = created.json<{ id: string }>().id;

    // No explicit visibility in the request — the trap from the issue
    const note = await as(aliceCookie, 'POST', '/api/notes', {
      template_id: templateId,
    });
    expect(note.statusCode).toBe(201);
    const { id: noteId, visibility } = note.json<{ id: string; visibility: string }>();
    expect(visibility).toBe('private');

    // And the receipt: Bob cannot see it
    const bob = await as(bobCookie, 'GET', `/api/notes/${noteId}`);
    expect(bob.statusCode).toBe(404);
  });

  it('an explicit choice in the request still wins', async () => {
    const created = await as(aliceCookie, 'POST', '/api/notes', {
      title: 'Shopping list frame',
      visibility: 'private',
      is_template: true,
    });
    const templateId = created.json<{ id: string }>().id;

    const note = await as(aliceCookie, 'POST', '/api/notes', {
      template_id: templateId,
      visibility: 'shared',
    });
    expect(note.json<{ visibility: string }>().visibility).toBe('shared');
  });
});

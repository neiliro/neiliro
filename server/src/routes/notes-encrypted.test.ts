import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  Notes with encrypted words (ADR 0001, #215) and the search corpus (#216).

  The server's part is small and has to stay small: store envelopes as
  given, mint nothing it cannot bind to, derive nothing from ciphertext,
  and keep the old behaviour for plaintext rows from before. Opening the
  envelopes is the browser's business (web/src/lib/vault.ts).
*/

let h: Harness;
let alice = { userId: '', cookie: '' };
let bob = { userId: '', cookie: '' };

// What an envelope looks like on the wire; the server only recognises the prefix
const enc = (label: string) => `e1:AAAAAAAAAAAAAAAA:${Buffer.from(label).toString('base64url')}`;

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  bob = h.join('Bob');
});

describe('an encrypted note', () => {
  it('is created under the id the browser minted, with its own preview and links', async () => {
    const noteId = '4d2a1c3e-9c2b-4a6f-8f1d-0f7e6b5a4c3d';
    const created = await h.as(alice.cookie, 'POST', '/api/notes', {
      id: noteId,
      title: enc('Trip plan'),
      body_md: enc('Pack [[Passports]]'),
      excerpt: enc('Pack Passports'),
      links: [{ title: enc('Passports'), target_note_id: null }],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ id: string }>().id).toBe(noteId);

    // Stored as given: no normalisation, no server-made preview
    const list = (await h.as(alice.cookie, 'GET', '/api/notes')).json<{ id: string; title: string; excerpt: string }[]>();
    const row = list.find((n) => n.id === noteId)!;
    expect(row.title).toBe(enc('Trip plan'));
    expect(row.excerpt).toBe(enc('Pack Passports'));

    const full = (await h.as(alice.cookie, 'GET', `/api/notes/${noteId}`)).json<{
      body_md: string;
      outgoing: { target_title: string; target_note_id: string | null }[];
    }>();
    expect(full.body_md).toBe(enc('Pack [[Passports]]'));
    expect(full.outgoing).toEqual([{ target_title: enc('Passports'), target_note_id: null, exists_now: 0 }]);

    // A second note under the same id is refused, not overwritten
    const again = await h.as(alice.cookie, 'POST', '/api/notes', { id: noteId, title: enc('Other') });
    expect(again.statusCode).toBe(409);
  });

  it('keeps the browser-resolved links and never rebuilds them from ciphertext', async () => {
    const target = (await h.as(alice.cookie, 'POST', '/api/notes', { title: enc('Passports') })).json<{ id: string }>();
    const source = (
      await h.as(alice.cookie, 'POST', '/api/notes', {
        title: enc('Trip'),
        body_md: enc('see [[Passports]]'),
        links: [{ title: enc('Passports'), target_note_id: null }],
      })
    ).json<{ id: string }>();

    // The browser re-resolves and sends only the links
    const patched = await h.as(alice.cookie, 'PATCH', `/api/notes/${source.id}`, {
      links: [{ title: enc('Passports'), target_note_id: target.id }],
    });
    expect(patched.statusCode).toBe(200);
    const full = (await h.as(alice.cookie, 'GET', `/api/notes/${source.id}`)).json<{
      outgoing: { target_note_id: string | null; exists_now: number }[];
    }>();
    expect(full.outgoing).toEqual([{ target_title: enc('Passports'), target_note_id: target.id, exists_now: 1 }]);
    // ...and the target lists the source as a backlink
    const back = (await h.as(alice.cookie, 'GET', `/api/notes/${target.id}`)).json<{ backlinks: { id: string }[] }>();
    expect(back.backlinks.map((b) => b.id)).toEqual([source.id]);

    // A body edit without links leaves the links alone rather than wiping them
    await h.as(alice.cookie, 'PATCH', `/api/notes/${source.id}`, { body_md: enc('see [[Passports]] and more') });
    const after = (await h.as(alice.cookie, 'GET', `/api/notes/${source.id}`)).json<{ outgoing: unknown[] }>();
    expect(after.outgoing).toHaveLength(1);
  });

  it('a plaintext note from before still gets its links and preview made here', async () => {
    const legacy = (
      await h.as(alice.cookie, 'POST', '/api/notes', { title: 'Old note', body_md: '**Bold** and [[Trip plan]]' })
    ).json<{ id: string }>();
    const list = (await h.as(alice.cookie, 'GET', '/api/notes')).json<{ id: string; excerpt: string }[]>();
    expect(list.find((n) => n.id === legacy.id)!.excerpt).toBe('Bold and Trip plan');
    const full = (await h.as(alice.cookie, 'GET', `/api/notes/${legacy.id}`)).json<{ outgoing: { target_title: string }[] }>();
    expect(full.outgoing.map((l) => l.target_title)).toEqual(['Trip plan']);
  });

  it('versions carry the ciphertext as snapshotted and can be rewritten by the migration job', async () => {
    const note = (await h.as(bob.cookie, 'POST', '/api/notes', { title: 'Plain', body_md: 'plain body' })).json<{ id: string }>();
    // Alice edits: a snapshot of Bob's plaintext appears
    await h.as(alice.cookie, 'PATCH', `/api/notes/${note.id}`, { title: enc('Plain'), body_md: enc('plain body v2') });
    const versions = (await h.as(bob.cookie, 'GET', `/api/notes/${note.id}/versions`)).json<{ id: string; title: string }[]>();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.title).toBe('Plain');
    // The job encrypts the historical row in place
    const sealed = await h.as(bob.cookie, 'PATCH', `/api/notes/${note.id}/versions/${versions[0]!.id}`, {
      title: enc('Plain'),
      body_md: enc('plain body'),
    });
    expect(sealed.statusCode).toBe(200);
    const detail = (await h.as(bob.cookie, 'GET', `/api/notes/${note.id}/versions/${versions[0]!.id}`)).json<{ body_md: string }>();
    expect(detail.body_md).toBe(enc('plain body'));
    // Half a rewrite is refused
    expect((await h.as(bob.cookie, 'PATCH', `/api/notes/${note.id}/versions/${versions[0]!.id}`, { title: enc('x') })).statusCode).toBe(400);
  });
});

describe('the search corpus (#216)', () => {
  it('applies owner_id: a private note reaches its owner only, ciphertext included', async () => {
    await h.as(bob.cookie, 'POST', '/api/notes', { title: enc('Bob diary'), body_md: enc('secret'), visibility: 'private' });
    await h.as(bob.cookie, 'POST', '/api/notes', { title: enc('Shared shopping'), body_md: enc('milk') });
    type Corpus = { notes: { title: string; visibility: string }[]; tasks: unknown[]; events: unknown[] };
    const forBob = (await h.as(bob.cookie, 'GET', '/api/search/corpus')).json<Corpus>();
    const forAlice = (await h.as(alice.cookie, 'GET', '/api/search/corpus')).json<Corpus>();
    expect(forBob.notes.map((n) => n.title)).toContain(enc('Bob diary'));
    expect(forAlice.notes.map((n) => n.title)).not.toContain(enc('Bob diary'));
    expect(forAlice.notes.map((n) => n.title)).toContain(enc('Shared shopping'));
    // The text comes back as stored — the server does not pretend to read it
    expect(forAlice.notes.find((n) => n.title === enc('Shared shopping'))).toMatchObject({ visibility: 'shared' });
  });
});

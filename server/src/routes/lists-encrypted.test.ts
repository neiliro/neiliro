import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  Lists with encrypted words (ADR 0001, #220): stored as given, and the
  guest link opens them only when it carries the key — the same
  arrangement as the calendar feed (#218), for the same reason.
*/
let h: Harness;
let alice = { userId: '', cookie: '' };

const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
const keyB64 = Buffer.from(rawKey).toString('base64url');
let key: webcrypto.CryptoKey;

async function seal(table: string, column: string, id: string, text: string): Promise<string> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(`${table}/${column}/${id}`) },
    key,
    Buffer.from(text, 'utf8'),
  );
  return `e1:${Buffer.from(nonce).toString('base64url')}:${Buffer.from(ct).toString('base64url')}`;
}

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  key = await webcrypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
});

describe('an encrypted list', () => {
  const listId = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
  const itemId = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f';
  const sectionId = 'd3e4f5a6-b7c8-4d9e-8f0a-2b3c4d5e6f7a';

  it('is created under browser-minted ids, items and sections too, and refuses duplicates', async () => {
    const list = await h.as(alice.cookie, 'POST', '/api/lists', { id: listId, title: await seal('lists', 'title', listId, 'Groceries') });
    expect(list.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/lists', { id: listId, title: 'x' })).statusCode).toBe(409);

    const section = await h.as(alice.cookie, 'POST', `/api/lists/${listId}/sections`, { id: sectionId, title: await seal('list_sections', 'title', sectionId, 'Dairy') });
    expect(section.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', `/api/lists/${listId}/sections`, { id: sectionId, title: 'x' })).statusCode).toBe(409);

    const item = await h.as(alice.cookie, 'POST', `/api/lists/${listId}/items`, { id: itemId, title: await seal('list_items', 'title', itemId, 'Milk'), section_id: sectionId });
    expect(item.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', `/api/lists/${listId}/items`, { id: itemId, title: 'x' })).statusCode).toBe(409);

    const full = (await h.as(alice.cookie, 'GET', `/api/lists/${listId}`)).json<{ title: string; items: { title: string }[]; sections: { title: string }[] }>();
    expect(full.title.startsWith('e1:')).toBe(true);
    expect(full.items[0]!.title.startsWith('e1:')).toBe(true);
    expect(full.sections[0]!.title.startsWith('e1:')).toBe(true);
  });

  it('lets an item be renamed, so the one-time job can rewrite plaintext', async () => {
    const renamed = await h.as(alice.cookie, 'PATCH', `/api/list-items/${itemId}`, { title: await seal('list_items', 'title', itemId, 'Oat milk') });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ title: string }>().title.startsWith('e1:')).toBe(true);
  });

  it('opens for a guest whose link carries the key, and shows dots without it', async () => {
    const share = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {})).json<{ path: string }>();

    const withKey = await h.app.inject({ url: `/api${share.path}~${keyB64}` });
    expect(withKey.statusCode).toBe(200);
    const opened = withKey.json<{ title: string; items: { id: string; title: string }[]; sections: { title: string }[] }>();
    expect(opened.title).toBe('Groceries');
    expect(opened.items[0]!.title).toBe('Oat milk');
    expect(opened.sections[0]!.title).toBe('Dairy');

    const toggled = await h.app.inject({ method: 'POST', url: `/api${share.path}~${keyB64}/items/${itemId}/toggle` });
    expect(toggled.json<{ title: string; checked_at: string | null }>()).toMatchObject({ title: 'Oat milk' });
    expect(toggled.json<{ checked_at: string | null }>().checked_at).not.toBeNull();

    const bare = await h.app.inject({ url: `/api${share.path}` });
    expect(bare.statusCode).toBe(200);
    expect(bare.json<{ title: string }>().title).toBe('••••••');
  });
});

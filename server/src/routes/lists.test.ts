import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  Shared lists (#11).

  Two things are worth pinning here, and neither is CRUD. First, the
  ordering: it *is* the "auto-clear" behaviour the issue asks for — the
  list reads clean because checked items sink, not because anything was
  deleted behind the family's back. Second, sharing: every other
  user-owned thing in this hub is private per person, so a list being
  visible to everyone is the one place where the absence of an owner check
  is the correct answer rather than a missing guard.
*/

const SHOPPING = '00000000-0000-4000-8000-000000000301';

let h: Harness;
let alice: { userId: string; cookie: string };
let bob: { userId: string; cookie: string };

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  bob = h.join('Bob');
});

async function items(cookie: string, listId = SHOPPING) {
  const res = await h.as(cookie, 'GET', `/api/lists/${listId}`);
  expect(res.statusCode).toBe(200);
  return res.json<{ items: { id: string; title: string; checked_at: string | null }[] }>().items;
}

async function add(cookie: string, title: string, listId = SHOPPING) {
  const res = await h.as(cookie, 'POST', `/api/lists/${listId}/items`, { title });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('shared lists', () => {
  it('ships one list, so the feature works before anyone configures anything', async () => {
    const res = await h.as(alice.cookie, 'GET', '/api/lists');
    const lists = res.json<{ id: string; title: string }[]>();
    expect(lists.map((l) => l.id)).toContain(SHOPPING);
    // English seed; the client translates it back by id (listTitle)
    expect(lists.find((l) => l.id === SHOPPING)!.title).toBe('Shopping');
  });

  it('is shared: what one person adds, the other sees', async () => {
    await add(alice.cookie, 'milk');
    // The deliberate opposite of notes — no owner filter, by design
    expect((await items(bob.cookie)).map((i) => i.title)).toEqual(['milk']);
  });

  it('keeps duplicates, because two bottles are two items', async () => {
    await add(bob.cookie, 'milk');
    const titles = (await items(alice.cookie)).map((i) => i.title);
    expect(titles.filter((t) => t === 'milk')).toHaveLength(2);
  });

  it('adds to the end, so the list reads in the order it was written', async () => {
    await add(alice.cookie, 'bread');
    expect((await items(alice.cookie)).map((i) => i.title)).toEqual(['milk', 'milk', 'bread']);
  });

  it('sinks checked items instead of deleting them', async () => {
    const [first] = await items(alice.cookie);
    const toggled = await h.as(bob.cookie, 'POST', `/api/list-items/${first!.id}/toggle`);
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json<{ checked_at: string | null }>().checked_at).toBeTruthy();

    const after = await items(alice.cookie);
    // Still there, and now last: bought is visible on the walk home
    expect(after).toHaveLength(3);
    expect(after[after.length - 1]!.id).toBe(first!.id);
    expect(after.slice(0, 2).every((i) => i.checked_at === null)).toBe(true);
  });

  it('unchecks back, so a mis-tap in a shop is one tap to undo', async () => {
    const checked = (await items(alice.cookie)).find((i) => i.checked_at)!;
    await h.as(alice.cookie, 'POST', `/api/list-items/${checked.id}/toggle`);
    expect((await items(alice.cookie)).every((i) => i.checked_at === null)).toBe(true);
  });

  it('clears only the checked pile, and says how much it removed', async () => {
    const all = await items(alice.cookie);
    await h.as(alice.cookie, 'POST', `/api/list-items/${all[0]!.id}/toggle`);
    await h.as(alice.cookie, 'POST', `/api/list-items/${all[1]!.id}/toggle`);

    const cleared = await h.as(alice.cookie, 'POST', `/api/lists/${SHOPPING}/clear-checked`);
    expect(cleared.json<{ cleared: number }>().cleared).toBe(2);

    const left = await items(alice.cookie);
    expect(left).toHaveLength(1);
    expect(left[0]!.checked_at).toBeNull();
  });

  it('counts open and checked items for the list index', async () => {
    await add(alice.cookie, 'eggs');
    const eggs = (await items(alice.cookie)).find((i) => i.title === 'eggs')!;
    await h.as(alice.cookie, 'POST', `/api/list-items/${eggs.id}/toggle`);

    const lists = (await h.as(alice.cookie, 'GET', '/api/lists')).json<
      { id: string; open_items: number; checked_items: number }[]
    >();
    const shopping = lists.find((l) => l.id === SHOPPING)!;
    expect(shopping.open_items).toBe(1);
    expect(shopping.checked_items).toBe(1);
  });

  it('takes its items with it when a list is deleted', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Hardware store' });
    const listId = made.json<{ id: string }>().id;
    const itemId = await add(alice.cookie, 'screws', listId);

    expect((await h.as(alice.cookie, 'DELETE', `/api/lists/${listId}`)).statusCode).toBe(200);
    expect((await h.as(alice.cookie, 'GET', `/api/lists/${listId}`)).statusCode).toBe(404);
    // ON DELETE CASCADE, not orphans
    expect((await h.as(alice.cookie, 'POST', `/api/list-items/${itemId}/toggle`)).statusCode).toBe(404);
  });

  it('refuses an empty name and an unknown list', async () => {
    expect((await h.as(alice.cookie, 'POST', '/api/lists', { title: '   ' })).statusCode).toBe(400);
    const ghostList = '00000000-0000-4000-8000-0000000009f9';
    expect((await h.as(alice.cookie, 'POST', `/api/lists/${ghostList}/items`, { title: 'x' })).statusCode).toBe(404);
  });
});

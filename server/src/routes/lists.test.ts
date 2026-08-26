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

  it('shares a list by link, and a guest sees only that list', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Hardware run' });
    const listId = made.json<{ id: string }>().id;
    await add(alice.cookie, 'screws', listId);

    const shared = await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {});
    expect(shared.statusCode).toBe(201);
    const token = shared.json<{ path: string }>().path.replace('/list/', '');

    // No session at all: this is a neighbour with a link
    const guest = await h.app.inject({ url: `/api/list/${token}` });
    expect(guest.statusCode).toBe(200);
    const body = guest.json<{ title: string; items: { title: string }[] }>();
    expect(body.title).toBe('Hardware run');
    expect(body.items.map((i) => i.title)).toEqual(['screws']);
    // The household does not travel with the link
    expect(guest.body).not.toContain('Alice');
    expect(guest.body).not.toContain('Shopping');
  });

  it('lets a guest tick an item off, and nothing else', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Market' });
    const listId = made.json<{ id: string }>().id;
    const itemId = await add(alice.cookie, 'apples', listId);
    const token = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {}))
      .json<{ path: string }>()
      .path.replace('/list/', '');

    const ticked = await h.app.inject({
      method: 'POST',
      url: `/api/list/${token}/items/${itemId}/toggle`,
    });
    expect(ticked.statusCode).toBe(200);
    expect(ticked.json<{ checked_at: string | null }>().checked_at).toBeTruthy();
    // Visible to the family too — one list, one state
    expect((await items(alice.cookie, listId))[0]!.checked_at).toBeTruthy();

    // But a guest cannot add, rename or delete
    for (const [method, url, payload] of [
      ['POST', `/api/lists/${listId}/items`, { title: 'sneaked in' }],
      ['PATCH', `/api/lists/${listId}`, { title: 'renamed' }],
      ['DELETE', `/api/lists/${listId}`, undefined],
    ] as const) {
      const res = await h.app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('scopes a guest write to the shared list only', async () => {
    const mine = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Shared one' });
    const sharedId = mine.json<{ id: string }>().id;
    const token = (await h.as(alice.cookie, 'POST', `/api/lists/${sharedId}/share`, {}))
      .json<{ path: string }>()
      .path.replace('/list/', '');

    // An item from a different list, reached through this token
    const other = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Private one' });
    const otherItem = await add(alice.cookie, 'not yours', other.json<{ id: string }>().id);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/list/${token}/items/${otherItem}/toggle`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('kills the link when the list is deleted, and on revoke', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Temporary' });
    const listId = made.json<{ id: string }>().id;
    const token = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {}))
      .json<{ path: string }>()
      .path.replace('/list/', '');
    expect((await h.app.inject({ url: `/api/list/${token}` })).statusCode).toBe(200);

    // Revoke alone
    await h.as(alice.cookie, 'DELETE', `/api/lists/${listId}/share`);
    expect((await h.app.inject({ url: `/api/list/${token}` })).statusCode).toBe(404);

    // And a deleted list takes any link with it
    const again = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {}))
      .json<{ path: string }>()
      .path.replace('/list/', '');
    await h.as(alice.cookie, 'DELETE', `/api/lists/${listId}`);
    expect((await h.app.inject({ url: `/api/list/${again}` })).statusCode).toBe(404);
  });

  it('renames a list, keeping its items and its link', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Old name' });
    const listId = made.json<{ id: string }>().id;
    await add(alice.cookie, 'thing', listId);
    const token = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {}))
      .json<{ path: string }>()
      .path.replace('/list/', '');

    const renamed = await h.as(alice.cookie, 'PATCH', `/api/lists/${listId}`, { title: 'New name' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ title: string }>().title).toBe('New name');

    // A rename is not a new list: items stay, and the link keeps working
    expect((await items(alice.cookie, listId)).map((i) => i.title)).toEqual(['thing']);
    const guest = await h.app.inject({ url: `/api/list/${token}` });
    expect(guest.json<{ title: string }>().title).toBe('New name');
  });

  it('groups items into sections, and leaves sectionless items alone', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Supermarket' });
    const listId = made.json<{ id: string }>().id;
    const veg = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/sections`, { title: 'Vegetables' }))
      .json<{ id: string }>().id;

    // An item with a section, and one without — the second is normal, not
    // "unfiled": #11 says typing must never require choosing a place
    await h.as(alice.cookie, 'POST', `/api/lists/${listId}/items`, { title: 'tomatoes', section_id: veg });
    await h.as(alice.cookie, 'POST', `/api/lists/${listId}/items`, { title: 'batteries' });

    const list = (await h.as(alice.cookie, 'GET', `/api/lists/${listId}`)).json<{
      sections: { id: string; title: string }[];
      items: { title: string; section_id: string | null }[];
    }>();
    expect(list.sections.map((s) => s.title)).toEqual(['Vegetables']);
    expect(list.items.find((i) => i.title === 'tomatoes')!.section_id).toBe(veg);
    expect(list.items.find((i) => i.title === 'batteries')!.section_id).toBeNull();
  });

  it('moves an item into a section and back out', async () => {
    const made = await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Move test' });
    const listId = made.json<{ id: string }>().id;
    const dairy = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/sections`, { title: 'Dairy' }))
      .json<{ id: string }>().id;
    const itemId = await add(alice.cookie, 'cheese', listId);

    const moved = await h.as(alice.cookie, 'PATCH', `/api/list-items/${itemId}/section`, {
      section_id: dairy,
    });
    expect(moved.json<{ section_id: string | null }>().section_id).toBe(dairy);

    const out = await h.as(alice.cookie, 'PATCH', `/api/list-items/${itemId}/section`, { section_id: null });
    expect(out.json<{ section_id: string | null }>().section_id).toBeNull();
  });

  it('refuses a section belonging to another list', async () => {
    const a = (await h.as(alice.cookie, 'POST', '/api/lists', { title: 'List A' })).json<{ id: string }>().id;
    const b = (await h.as(alice.cookie, 'POST', '/api/lists', { title: 'List B' })).json<{ id: string }>().id;
    const sectionInB = (await h.as(alice.cookie, 'POST', `/api/lists/${b}/sections`, { title: 'Elsewhere' }))
      .json<{ id: string }>().id;

    // Either way round this would make the item disappear from the list
    // it belongs to, which reads as data loss
    const onCreate = await h.as(alice.cookie, 'POST', `/api/lists/${a}/items`, {
      title: 'stray',
      section_id: sectionInB,
    });
    expect(onCreate.statusCode).toBe(400);

    const itemInA = await add(alice.cookie, 'settled', a);
    const onMove = await h.as(alice.cookie, 'PATCH', `/api/list-items/${itemInA}/section`, {
      section_id: sectionInB,
    });
    expect(onMove.statusCode).toBe(400);
  });

  it('keeps the items when a section is deleted', async () => {
    const listId = (await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Tidy up' })).json<{ id: string }>().id;
    const section = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/sections`, { title: 'Bakery' }))
      .json<{ id: string }>().id;
    await h.as(alice.cookie, 'POST', `/api/lists/${listId}/items`, { title: 'sourdough', section_id: section });

    expect((await h.as(alice.cookie, 'DELETE', `/api/list-sections/${section}`)).statusCode).toBe(200);

    const list = (await h.as(alice.cookie, 'GET', `/api/lists/${listId}`)).json<{
      sections: unknown[];
      items: { title: string; section_id: string | null }[];
    }>();
    // The heading is gone; the bread is not
    expect(list.sections).toEqual([]);
    expect(list.items.map((i) => i.title)).toEqual(['sourdough']);
    expect(list.items[0]!.section_id).toBeNull();
  });

  it('shows sections to a guest, who is usually the one in the shop', async () => {
    const listId = (await h.as(alice.cookie, 'POST', '/api/lists', { title: 'Guest sections' })).json<{ id: string }>().id;
    const aisle = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/sections`, { title: 'Frozen' }))
      .json<{ id: string }>().id;
    await h.as(alice.cookie, 'POST', `/api/lists/${listId}/items`, { title: 'peas', section_id: aisle });
    const token = (await h.as(alice.cookie, 'POST', `/api/lists/${listId}/share`, {}))
      .json<{ path: string }>().path.replace('/list/', '');

    const guest = (await h.app.inject({ url: `/api/list/${token}` })).json<{
      sections: { title: string }[];
      items: { title: string; section_id: string | null }[];
    }>();
    expect(guest.sections.map((s) => s.title)).toEqual(['Frozen']);
    expect(guest.items[0]!.section_id).toBe(aisle);
  });

  it('refuses an empty name and an unknown list', async () => {
    expect((await h.as(alice.cookie, 'POST', '/api/lists', { title: '   ' })).statusCode).toBe(400);
    const ghostList = '00000000-0000-4000-8000-0000000009f9';
    expect((await h.as(alice.cookie, 'POST', `/api/lists/${ghostList}/items`, { title: 'x' })).statusCode).toBe(404);
  });
});

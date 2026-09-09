import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { id, now, runWithDb } from '../db/index.js';
import { createSession } from '../lib/auth.js';

/*
  The two rules that carry #68, as tests:

  1. The wish owner must never learn what is claimed — not the flag, not
     the name, not through the public page. The surprise is enforced by
     the server, exactly like money masking, and a regression here is the
     naive implementation the issue warns about.

  2. The public wishlist link is the hub's first anonymous surface, so
     what it reveals is pinned down to the byte: one first name, wish
     titles, a reserved flag. No family names, no allergies, nothing.
*/

let hub: Harness;
let aliceId = '';
let aliceCookie = '';
let bobCookie = '';
let kateId = '';
let kateCookie = '';

function joinMember(name: string): { userId: string; cookie: string } {
  return runWithDb(hub.db, () => {
    const userId = id();
    hub.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, color, created_at)
         VALUES (?, ?, ?, 'member', 'x', '#C4842B', ?)`,
      )
      .run(userId, `${name}@hub.local`, name, now());
    return { userId, cookie: createSession(userId, `${name}-device`) };
  });
}

beforeAll(async () => {
  hub = await buildTestApp();
  const alice = hub.join('alice');
  aliceId = alice.userId;
  aliceCookie = alice.cookie;
  bobCookie = hub.join('bob').cookie;
  const kate = joinMember('kate');
  kateId = kate.userId;
  kateCookie = kate.cookie;
});

describe('editing boundary (the #64 asymmetry)', () => {
  it('a member edits their own profile, not others’', async () => {
    const own = await hub.as(kateCookie, 'PATCH', `/api/profiles/${kateId}`, {
      birthday: '1992-03-14',
      family_role: 'mother',
    });
    expect(own.statusCode).toBe(200);
    const other = await hub.as(kateCookie, 'PATCH', `/api/profiles/${aliceId}`, {
      family_role: 'father',
    });
    expect(other.statusCode).toBe(403);
  });

  it('the admin maintains anyone’s (a kid without a device)', async () => {
    const res = await hub.as(aliceCookie, 'PATCH', `/api/profiles/${kateId}`, {
      family_role: 'mother',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('the birthday feeds the calendar, never forks from it', () => {
  it('saving a birthday derives one yearly shared event with birth_year', async () => {
    await hub.as(kateCookie, 'PATCH', `/api/profiles/${kateId}`, { birthday: '1992-03-14' });
    const events = hub.db
      .prepare('SELECT title, starts_at, recurrence_rule, birth_year, calendar_id FROM events WHERE profile_user_id = ?')
      .all(kateId) as { starts_at: string; recurrence_rule: string; birth_year: number }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      starts_at: '1992-03-14',
      recurrence_rule: 'FREQ=YEARLY',
      birth_year: 1992,
      calendar_id: '00000000-0000-4000-8000-000000000201',
    });
  });

  it('changing the date moves the same event; clearing removes it', async () => {
    await hub.as(kateCookie, 'PATCH', `/api/profiles/${kateId}`, { birthday: '1992-03-15' });
    const moved = hub.db
      .prepare('SELECT starts_at FROM events WHERE profile_user_id = ?')
      .all(kateId) as { starts_at: string }[];
    expect(moved).toHaveLength(1);
    expect(moved[0]!.starts_at).toBe('1992-03-15');

    await hub.as(kateCookie, 'PATCH', `/api/profiles/${kateId}`, { birthday: null });
    expect(hub.db.prepare('SELECT count(*) n FROM events WHERE profile_user_id = ?').get(kateId)).toEqual({ n: 0 });
  });
});

describe('the owner never learns what is claimed', () => {
  let wishId = '';

  beforeAll(async () => {
    const created = await hub.as(kateCookie, 'POST', `/api/profiles/${kateId}/wishes`, {
      title: 'A red bicycle',
    });
    wishId = created.json<{ id: string }>().id;
    const claim = await hub.as(bobCookie, 'POST', `/api/wishes/${wishId}/claim`);
    expect(claim.statusCode).toBe(200);
  });

  it('the owner’s view carries no claim fields at all', async () => {
    const res = await hub.as(kateCookie, 'GET', `/api/profiles/${kateId}`);
    const wish = res.json<{ wishes: Record<string, unknown>[] }>().wishes[0]!;
    expect(wish.title).toBe('A red bicycle');
    expect(wish).not.toHaveProperty('claimed');
    expect(wish).not.toHaveProperty('claimed_by');
    expect(wish).not.toHaveProperty('claimed_by_name');
    expect(wish).not.toHaveProperty('claimed_at');
  });

  it('another family member sees who reserved it', async () => {
    const res = await hub.as(aliceCookie, 'GET', `/api/profiles/${kateId}`);
    const wish = res.json<{ wishes: { claimed: boolean; claimed_by_name: string }[] }>().wishes[0]!;
    expect(wish.claimed).toBe(true);
    expect(wish.claimed_by_name).toBe('bob');
  });

  it('a second claim answers 409, the owner claiming answers 404', async () => {
    expect((await hub.as(aliceCookie, 'POST', `/api/wishes/${wishId}/claim`)).statusCode).toBe(409);
    expect((await hub.as(kateCookie, 'POST', `/api/wishes/${wishId}/claim`)).statusCode).toBe(404);
  });

  it('only the claimer (or the admin) takes a reservation back', async () => {
    const kate = await hub.as(kateCookie, 'DELETE', `/api/wishes/${wishId}/claim`);
    expect(kate.statusCode).toBe(403);
    const bob = await hub.as(bobCookie, 'DELETE', `/api/wishes/${wishId}/claim`);
    expect(bob.statusCode).toBe(200);
  });
});

describe('the public link', () => {
  let token = '';
  let wishId = '';

  beforeAll(async () => {
    const created = await hub.as(kateCookie, 'POST', `/api/profiles/${kateId}/wishes`, {
      title: 'Wool socks',
    });
    wishId = created.json<{ id: string }>().id;
    const share = await hub.as(kateCookie, 'POST', `/api/profiles/${kateId}/wishlist-share`);
    expect(share.statusCode).toBe(201);
    token = share.json<{ path: string }>().path.replace('/wish/', '');
  });

  it('answers without any session, and reveals only name + titles + flags', async () => {
    // No cookie at all — the anonymous surface
    const res = await hub.app.inject({ method: 'GET', url: `/api/wishlist/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; wishes: Record<string, unknown>[] };
    expect(body.name).toBe('kate');
    expect(Object.keys(body).sort()).toEqual(['name', 'wishes']);
    for (const w of body.wishes) {
      // reserved is a flag; a guest page must not enumerate the family
      expect(Object.keys(w).sort()).toEqual(['id', 'reserved', 'title', 'url']);
    }
  });

  it('a guest reserves with a typed name; the flag flips, the name stays off the page', async () => {
    const claim = await hub.app.inject({
      method: 'POST',
      url: `/api/wishlist/${token}/claim`,
      payload: { wish_id: wishId, name: 'Grandma Vera' },
    });
    expect(claim.statusCode).toBe(200);

    const page = await hub.app.inject({ method: 'GET', url: `/api/wishlist/${token}` });
    const wish = (page.json() as { wishes: { id: string; reserved: boolean }[] }).wishes.find(
      (w) => w.id === wishId,
    )!;
    expect(wish.reserved).toBe(true);
    expect(wish).not.toHaveProperty('claimed_by_name');

    // The family sees the guest's name inside the hub…
    const family = await hub.as(aliceCookie, 'GET', `/api/profiles/${kateId}`);
    const inHub = family
      .json<{ wishes: { id: string; claimed_by_name: string | null }[] }>()
      .wishes.find((w) => w.id === wishId)!;
    expect(inHub.claimed_by_name).toBe('Grandma Vera');

    // …and the owner still sees nothing
    const own = await hub.as(kateCookie, 'GET', `/api/profiles/${kateId}`);
    const ownView = own.json<{ wishes: Record<string, unknown>[] }>().wishes.find((w) => w.id === wishId)!;
    expect(ownView).not.toHaveProperty('claimed');
    expect(ownView).not.toHaveProperty('claimed_by_name');
  });

  it('the link survives a reload: self and admin can re-copy, a plain member cannot', async () => {
    // Fresh GETs, as after a page reload — no state carried from creation
    const own = await hub.as(kateCookie, 'GET', `/api/profiles/${kateId}`);
    expect(own.json<{ wishlist_share_path: string }>().wishlist_share_path).toBe(`/wish/${token}`);
    const admin = await hub.as(aliceCookie, 'GET', `/api/profiles/${kateId}`);
    expect(admin.json<{ wishlist_share_path: string }>().wishlist_share_path).toBe(`/wish/${token}`);
    // A plain member (bob is an admin by harness design) does not manage
    // Kate's sharing — they get the fact a link exists, never the link
    const mia = joinMember('mia');
    const plain = await hub.as(mia.cookie, 'GET', `/api/profiles/${kateId}`);
    expect(plain.json<{ wishlist_shared: boolean; wishlist_share_path: string | null }>()).toMatchObject({
      wishlist_shared: true,
      wishlist_share_path: null,
    });
  });

  it('a wrong token is 404, a revoked link dies', async () => {
    const wrong = await hub.app.inject({ method: 'GET', url: '/api/wishlist/definitely-not-a-token-1234' });
    expect(wrong.statusCode).toBe(404);

    await hub.as(kateCookie, 'DELETE', `/api/profiles/${kateId}/wishlist-share`);
    const revoked = await hub.app.inject({ method: 'GET', url: `/api/wishlist/${token}` });
    expect(revoked.statusCode).toBe(404);
  });
});

describe('entries', () => {
  it('allergies surface on the family list without opening the profile', async () => {
    const created = await hub.as(kateCookie, 'POST', `/api/profiles/${kateId}/entries`, {
      kind: 'allergy',
      label: 'nuts',
    });
    expect(created.statusCode).toBe(201);
    const list = await hub.as(bobCookie, 'GET', '/api/profiles');
    const kate = list.json<{ id: string; allergies: { id: string; label: string }[] }[]>().find((u) => u.id === kateId)!;
    expect(kate.allergies.map((a) => a.label)).toContain('nuts');
  });
});

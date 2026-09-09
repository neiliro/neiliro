import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { createSession } from '../lib/auth.js';
import { id, now, runWithDb } from '../db/index.js';

/*
  Profile entries with encrypted words (ADR 0001, #221): allergies and
  preferences are stored as given, reach the family list as rows the
  browser can open, and can be rewritten by the one-time job.
*/
let h: Harness;
let alice = { userId: '', cookie: '' };
let bob = { userId: '', cookie: '' };

const enc = (label: string) => `e1:AAAAAAAAAAAAAAAA:${Buffer.from(label).toString('base64url')}`;

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  // The harness joins admins; a member is what the boundary is about
  bob = runWithDb(h.db, () => {
    const userId = id();
    h.db
      .prepare(`INSERT INTO users (id, email, name, role, password_hash, color, created_at) VALUES (?, ?, ?, 'member', 'x', '#C4842B', ?)`)
      .run(userId, 'bob@hub.local', 'Bob', now());
    return { userId, cookie: createSession(userId, 'bob-device') };
  });
});

describe('encrypted profile entries', () => {
  const entryId = 'e4f5a6b7-c8d9-4e0f-8a1b-2c3d4e5f6a7b';

  it('are stored as given under the browser-minted id and surface as rows on the family list', async () => {
    const created = await h.as(alice.cookie, 'POST', `/api/profiles/${alice.userId}/entries`, {
      id: entryId, kind: 'allergy', label: enc('nuts'), value: enc('epipen in the bag'),
    });
    expect(created.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', `/api/profiles/${alice.userId}/entries`, { id: entryId, kind: 'allergy', label: 'x' })).statusCode).toBe(409);

    const list = (await h.as(bob.cookie, 'GET', '/api/profiles')).json<{ id: string; allergies: { id: string; label: string }[] }[]>();
    const aliceRow = list.find((u) => u.id === alice.userId)!;
    expect(aliceRow.allergies).toEqual([{ id: entryId, label: enc('nuts') }]);
  });

  it('can be rewritten by the member or the admin, not by anyone else', async () => {
    const own = await h.as(alice.cookie, 'PATCH', `/api/profiles/${alice.userId}/entries/${entryId}`, { label: enc('tree nuts') });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ label: string }>().label).toBe(enc('tree nuts'));

    const other = await h.as(bob.cookie, 'PATCH', `/api/profiles/${alice.userId}/entries/${entryId}`, { label: 'x' });
    expect(other.statusCode).toBe(403);
  });
});

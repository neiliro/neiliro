import { beforeEach, describe, expect, it } from 'vitest';
import { authKey, buildTestApp, type Harness } from '../test-harness.js';
import { hashPassword } from './password.js';

/*
  A member leaves for good (GDPR art. 17). The test pins the rule in
  lib/erase-member.ts: everything only this person could see is gone,
  what the family shares stays, and the shared account's balance does not
  move because someone left — a transfer between a personal and a shared
  account is kept without its words.
*/

describe('erasing a member', () => {
  let h: Harness;
  let admin: { userId: string; cookie: string };
  let member: { userId: string; cookie: string };
  let sharedAccount: string;

  beforeEach(async () => {
    h = await buildTestApp();
    admin = h.join('Ann');
    member = h.join('Max');
    h.db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(member.userId);

    const priv = await h.as(member.cookie, 'POST', '/api/notes', { title: 'My diary', visibility: 'private' });
    expect(priv.statusCode).toBe(201);
    const shared = await h.as(member.cookie, 'POST', '/api/notes', { title: 'Grocery run', visibility: 'shared' });
    expect(shared.statusCode).toBe(201);

    const cal = await h.as(member.cookie, 'POST', '/api/calendars', { name: 'Max only', shared: false });
    expect(cal.statusCode).toBe(201);
    const ev = await h.as(member.cookie, 'POST', '/api/events', {
      calendar_id: cal.json<{ id: string }>().id,
      title: 'Dentist',
      starts_at: '2026-10-01T10:00',
      ends_at: '2026-10-01T11:00',
    });
    expect(ev.statusCode).toBe(201);

    const sa = await h.as(admin.cookie, 'POST', '/api/accounts', { name: 'Family card', currency: 'EUR', shared: true, opening_balance: 100_000 });
    expect(sa.statusCode).toBe(201);
    sharedAccount = sa.json<{ id: string }>().id;
    const pa = await h.as(member.cookie, 'POST', '/api/accounts', { name: 'Max wallet', currency: 'EUR', shared: false });
    expect(pa.statusCode).toBe(201);
    const personal = pa.json<{ id: string }>().id;
    // €200 from the family card into Max's wallet, then €50 spent from the wallet
    expect(
      (await h.as(member.cookie, 'POST', '/api/transactions', {
        kind: 'transfer', account_id: sharedAccount, to_account_id: personal, amount: 20_000, to_amount: 20_000,
        occurred_on: '2026-09-01', note: 'pocket money',
      })).statusCode,
    ).toBe(201);
    expect(
      (await h.as(member.cookie, 'POST', '/api/transactions', {
        kind: 'expense', account_id: personal, amount: 5_000, occurred_on: '2026-09-02', note: 'cinema',
      })).statusCode,
    ).toBe(201);

    expect(
      (await h.as(member.cookie, 'POST', `/api/profiles/${member.userId}/entries`, { kind: 'allergy', label: 'peanuts' })).statusCode,
    ).toBe(201);
  });

  it('removes what only the member could see and keeps the family record', async () => {
    const before = await h.as(admin.cookie, 'GET', '/api/accounts');
    const sharedBefore = before.json<{ id: string; balance: number }[]>().find((a) => a.id === sharedAccount)!.balance;
    expect(sharedBefore).toBe(80_000);

    const res = await h.as(admin.cookie, 'DELETE', `/api/users/${member.userId}`);
    expect(res.statusCode).toBe(200);

    // The tombstone: no name, no reachable address, no doors
    const row = h.db.prepare('SELECT * FROM users WHERE id = ?').get(member.userId) as Record<string, unknown>;
    expect(row.name).toBe('Former member');
    expect(row.email).toMatch(/^deleted-[0-9a-f]{8}@removed\.invalid$/);
    expect(row.deleted_at).toBeTruthy();
    expect(row.disabled_at).toBeTruthy();
    expect(row.kdf_salt).toBeNull();
    expect(h.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?').get(member.userId)).toEqual({ n: 0 });

    // Private note gone, shared one kept without an owner
    const titles = (h.db.prepare('SELECT title, owner_id FROM notes WHERE is_template = 0').all() as { title: string; owner_id: string | null }[]);
    expect(titles.map((t) => t.title)).not.toContain('My diary');
    expect(titles.find((t) => t.title === 'Grocery run')?.owner_id).toBeNull();

    // Personal calendar and its event gone
    expect(h.db.prepare("SELECT count(*) AS n FROM calendars WHERE name = 'Max only'").get()).toEqual({ n: 0 });
    expect(h.db.prepare("SELECT count(*) AS n FROM events WHERE title = 'Dentist'").get()).toEqual({ n: 0 });

    // Profile gone
    expect(h.db.prepare('SELECT count(*) AS n FROM profile_entries WHERE user_id = ?').get(member.userId)).toEqual({ n: 0 });

    // Money: the shared balance did not move; the transfer lost its words; the wallet's own spending is gone
    const after = await h.as(admin.cookie, 'GET', '/api/accounts');
    const accounts = after.json<{ id: string; name: string; balance: number; archived_at: string | null }[]>();
    expect(accounts.find((a) => a.id === sharedAccount)!.balance).toBe(sharedBefore);
    const tx = h.db.prepare('SELECT kind, note FROM transactions ORDER BY occurred_on').all() as { kind: string; note: string | null }[];
    expect(tx).toEqual([{ kind: 'transfer', note: null }]);
    const stub = h.db.prepare("SELECT name, archived_at FROM accounts WHERE shared = 0").get() as { name: string; archived_at: string | null };
    expect(stub).toEqual({ name: 'Former member', archived_at: expect.any(String) });

    // Gone from the People list, and nothing to sign in with
    const list = await h.as(admin.cookie, 'GET', '/api/users');
    expect(list.json<{ id: string }[]>().map((u) => u.id)).not.toContain(member.userId);
  });

  it('refuses the administrator removing themselves, and a second removal', async () => {
    expect((await h.as(admin.cookie, 'DELETE', `/api/users/${admin.userId}`)).statusCode).toBe(400);
    expect((await h.as(admin.cookie, 'DELETE', `/api/users/${member.userId}`)).statusCode).toBe(200);
    expect((await h.as(admin.cookie, 'DELETE', `/api/users/${member.userId}`)).statusCode).toBe(404);
  });

  it('lets a member leave on their own with their password, but not the last administrator', async () => {
    const key = await authKey('correct horse battery');
    for (const id of [admin.userId, member.userId]) {
      h.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(key), id);
    }
    expect((await h.as(member.cookie, 'POST', '/api/users/me/erase', { auth_key: await authKey('wrong') })).statusCode).toBe(400);
    expect((await h.as(admin.cookie, 'POST', '/api/users/me/erase', { auth_key: key })).statusCode).toBe(400);
    const left = await h.as(member.cookie, 'POST', '/api/users/me/erase', { auth_key: key });
    expect(left.statusCode).toBe(200);
    expect((await h.as(member.cookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { id, now, runWithDb } from '../db/index.js';
import { createSession } from '../lib/auth.js';

/*
  The self-service boundary of PATCH /api/users/:id (#64): a member owns
  their name and colour, and nothing else — the same route on someone
  else's id must stay administrator-only. The harness's join() creates
  administrators, so the member here is inserted directly.
*/

let hub: Harness;
let adminId = '';
let memberId = '';
let memberCookie = '';

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
  adminId = hub.join('alice').userId;
  const member = joinMember('kate');
  memberId = member.userId;
  memberCookie = member.cookie;
});

describe('GET /api/users', () => {
  it('leaves confirmation out of it on a self-hosted hub', async () => {
    /*
      A self-hosted login is an identifier people legitimately invent —
      name@hub.local in our own docs — and nothing there ever asks for the
      mailbox to be proven. A false here would put a permanent
      "unconfirmed" beside every member for a proof that will never be
      requested, so the answer is null: the question does not apply.
    */
    const res = await hub.as(hub.join('admin-list').cookie, 'GET', '/api/users');
    expect(res.statusCode).toBe(200);
    const users = res.json<{ email_verified: boolean | null }[]>();
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((u) => u.email_verified === null)).toBe(true);
  });
});

describe('PATCH /api/users/:id self-service', () => {
  it('a member changes their own name and colour', async () => {
    const res = await hub.as(memberCookie, 'PATCH', `/api/users/${memberId}`, {
      name: 'Kate',
      color: '#6B8F5E',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string; color: string }>()).toMatchObject({
      name: 'Kate',
      color: '#6B8F5E',
    });
  });

  it("a member cannot touch someone else's profile", async () => {
    const res = await hub.as(memberCookie, 'PATCH', `/api/users/${adminId}`, {
      name: 'Hacked',
    });
    expect(res.statusCode).toBe(403);
  });
});

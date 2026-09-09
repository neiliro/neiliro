import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  Money with encrypted words (ADR 0001, #219). The arithmetic never needed
  a name, so the server's part is: take the browser's ids, stop ordering by
  names it cannot read, and stop copying a rule's note into the
  transactions it makes — the transaction reads the rule's words instead.
*/
let h: Harness;
let alice = { userId: '', cookie: '' };
let bob = { userId: '', cookie: '' };

const enc = (label: string) => `e1:AAAAAAAAAAAAAAAA:${Buffer.from(label).toString('base64url')}`;

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  bob = h.join('Bob');
});

describe('encrypted money records', () => {
  const accountId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const categoryId = '8b7c6d5e-4f3a-4b2c-8d1e-0f9a8b7c6d5e';

  it('take the ids the browser minted and refuse duplicates', async () => {
    const account = await h.as(alice.cookie, 'POST', '/api/accounts', { id: accountId, name: enc('Wallet'), currency: 'EUR' });
    expect(account.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/accounts', { id: accountId, name: 'x', currency: 'EUR' })).statusCode).toBe(409);

    const category = await h.as(alice.cookie, 'POST', '/api/categories', { id: categoryId, name: enc('Food'), kind: 'expense' });
    expect(category.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/categories', { id: categoryId, name: 'x', kind: 'expense' })).statusCode).toBe(409);

    const txId = '7c6d5e4f-3a2b-4c1d-8e0f-9a8b7c6d5e4f';
    const tx = await h.as(alice.cookie, 'POST', '/api/transactions', {
      id: txId, kind: 'expense', occurred_on: '2026-09-01', account_id: accountId, amount: 1250, category_id: categoryId,
      note: enc('Bread'), place: enc('Bakery'),
    });
    expect(tx.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/transactions', { id: txId, kind: 'expense', occurred_on: '2026-09-01', account_id: accountId, amount: 1 })).statusCode).toBe(409);

    // Joined names come back as stored — envelopes the server never opened
    const list = (await h.as(alice.cookie, 'GET', `/api/transactions?account_id=${accountId}`)).json<{ id: string; note: string; account_name: string; category_name: string }[]>();
    const row = list.find((t) => t.id === txId)!;
    expect(row.note).toBe(enc('Bread'));
    expect(row.account_name).toBe(enc('Wallet'));
    expect(row.category_name).toBe(enc('Food'));
  });

  it('a rule-made transaction reads the rule’s words instead of copying ciphertext it cannot rebind', async () => {
    const ruleId = '6d5e4f3a-2b1c-4d0e-8f9a-8b7c6d5e4f3a';
    const rule = await h.as(alice.cookie, 'POST', '/api/recurring', {
      id: ruleId, title: enc('Rent'), kind: 'expense', start_on: '2026-01-05', recurrence_rule: 'FREQ=MONTHLY;INTERVAL=1',
      account_id: accountId, amount: 50000, note: enc('Flat'), place: enc('Landlord'), auto_create: true,
    });
    expect(rule.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/recurring', { id: ruleId, title: 'x', kind: 'expense', start_on: '2026-01-05', recurrence_rule: 'FREQ=MONTHLY', account_id: accountId, amount: 1 })).statusCode).toBe(409);

    const made = (await h.as(alice.cookie, 'GET', `/api/transactions?account_id=${accountId}&limit=500`)).json<{
      recurring_id: string | null; note: string | null; place: string | null; recurring_note: string | null; recurring_title: string | null;
    }[]>().filter((t) => t.recurring_id === ruleId);
    expect(made.length).toBeGreaterThan(0);
    for (const t of made) {
      expect(t.note).toBeNull();
      expect(t.place).toBeNull();
      expect(t.recurring_note).toBe(enc('Flat'));
      expect(t.recurring_title).toBe(enc('Rent'));
    }

    // The due list names the ids the browser opens the joined names under
    const due = (await h.as(alice.cookie, 'GET', '/api/recurring/due')).json<{ account_id?: string }[]>();
    for (const item of due) expect(typeof item.account_id).toBe('string');
  });

  it('a plaintext rule from before the key is still copied as before', async () => {
    const rule = (await h.as(alice.cookie, 'POST', '/api/recurring', {
      title: 'Gym', kind: 'expense', start_on: '2026-01-05', recurrence_rule: 'FREQ=MONTHLY;INTERVAL=1',
      account_id: accountId, amount: 3000, note: 'Monthly pass', auto_create: true,
    })).json<{ id: string }>();
    const made = (await h.as(alice.cookie, 'GET', `/api/transactions?account_id=${accountId}&limit=500`)).json<{ recurring_id: string | null; note: string | null }[]>()
      .filter((t) => t.recurring_id === rule.id);
    expect(made.length).toBeGreaterThan(0);
    expect(made[0]!.note).toBe('Monthly pass');
  });

  it('masks the inherited words of a hidden account along with its own', async () => {
    const personal = (await h.as(bob.cookie, 'POST', '/api/accounts', { name: enc('Bob’s'), currency: 'EUR', shared: false })).json<{ id: string }>();
    const shared = (await h.as(bob.cookie, 'POST', '/api/accounts', { name: 'Joint', currency: 'EUR' })).json<{ id: string }>();
    const rule = (await h.as(bob.cookie, 'POST', '/api/recurring', {
      title: enc('Allowance'), kind: 'transfer', start_on: '2026-01-05', recurrence_rule: 'FREQ=MONTHLY;INTERVAL=1',
      account_id: personal.id, amount: 100, to_account_id: shared.id, to_amount: 100, note: enc('secret'), auto_create: true,
    })).json<{ id: string }>();
    const seen = (await h.as(alice.cookie, 'GET', `/api/transactions?account_id=${shared.id}&limit=500`)).json<{ recurring_id: string | null; recurring_note: string | null; recurring_title: string | null; account_name: string }[]>()
      .filter((t) => t.recurring_id === rule.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.account_name).toBe('Personal account');
    expect(seen[0]!.recurring_note).toBeNull();
    expect(seen[0]!.recurring_title).toBeNull();
  });
});

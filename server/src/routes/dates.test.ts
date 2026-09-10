import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { runWithDb } from '../db/index.js';

/*
  A date is not a shape (#250). `2026-13-45` matched the old regex on five
  routes, and the first recurrence expansion over it threw for the whole
  family. Two things are pinned: the routes refuse an impossible date with
  the authored message, and a row that somehow carries one (written before
  the fix) no longer takes the dashboard and the calendar down.
*/
let h: Harness;
let cookie: string;
const INBOX = '00000000-0000-4000-8000-000000000001';
const SHARED = '00000000-0000-4000-8000-000000000201';

beforeAll(async () => {
  h = await buildTestApp();
  ({ cookie } = h.join('Alice'));
});

describe('impossible dates are refused', () => {
  it('on tasks, events, transactions, rules, reconciliation and birthdays', async () => {
    const me = (await h.as(cookie, 'GET', '/api/auth/me')).json<{ id: string }>();
    const account = (await h.as(cookie, 'POST', '/api/accounts', { name: 'Wallet', currency: 'EUR' })).json<{ id: string }>();
    const cases: [string, string, unknown, string][] = [
      ['POST', '/api/tasks', { project_id: INBOX, title: 'x', due_date: '2026-13-45' }, 'Date must be YYYY-MM-DD'],
      ['POST', '/api/tasks', { project_id: INBOX, title: 'x', expected_date: '2026-02-30' }, 'Date must be YYYY-MM-DD'],
      ['POST', '/api/events', { calendar_id: SHARED, title: 'x', starts_at: '2026-13-45', ends_at: '2026-13-45' }, 'Date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM'],
      ['POST', '/api/events', { calendar_id: SHARED, title: 'x', starts_at: '2026-09-10T25:00', ends_at: '2026-09-10T25:30' }, 'Date must be YYYY-MM-DD or YYYY-MM-DDTHH:MM'],
      ['POST', '/api/transactions', { kind: 'expense', occurred_on: '2026-00-10', account_id: account.id, amount: 5 }, 'Date must be YYYY-MM-DD'],
      ['POST', '/api/recurring', { title: 'x', kind: 'expense', start_on: '2026-04-31', recurrence_rule: 'FREQ=MONTHLY', account_id: account.id, amount: 5 }, 'Date must be YYYY-MM-DD'],
      ['POST', `/api/accounts/${account.id}/reconcile`, { checked_on: '2026-13-01', actual_balance: 1 }, 'Enter the date and the actual balance'],
      ['PATCH', `/api/profiles/${me.id}`, { birthday: '1990-13-01' }, 'Date must be YYYY-MM-DD'],
      ['PUT', '/api/budgets', { category_id: '00000000-0000-4000-8000-000000000000', currency: 'EUR', month: '2026-13', amount: 1 }, 'Month must be YYYY-MM'],
    ];
    for (const [method, url, body, message] of cases) {
      const res = await h.as(cookie, method as 'POST', url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(400);
      expect(res.json<{ error: string }>().error, `${method} ${url}`).toBe(message);
    }
    // Leap day is a real date; a real datetime passes
    expect((await h.as(cookie, 'POST', '/api/tasks', { project_id: INBOX, title: 'leap', due_date: '2028-02-29' })).statusCode).toBe(201);
    expect((await h.as(cookie, 'POST', '/api/events', { calendar_id: SHARED, title: 'ok', starts_at: '2026-09-10T09:00', ends_at: '2026-09-10T09:30' })).statusCode).toBe(201);
  });

  it('query windows are checked too', async () => {
    expect((await h.as(cookie, 'GET', '/api/events?from=2026-13-01&to=2026-13-31')).statusCode).toBe(400);
    expect((await h.as(cookie, 'GET', '/api/budgets?month=2026-13')).statusCode).toBe(400);
  });
});

describe('a bad row from before the fix', () => {
  it('is skipped by the calendar and the dashboard instead of taking them down', async () => {
    runWithDb(h.db, () => {
      h.db
        .prepare(
          `INSERT INTO events (id, calendar_id, title, starts_at, ends_at, all_day, recurrence_rule, created_at, updated_at)
           VALUES ('00000000-0000-4000-8000-00000000bad1', ?, 'legacy', '1990-13-01', '1990-13-01', 1, 'FREQ=YEARLY', datetime('now'), datetime('now'))`,
        )
        .run(SHARED);
    });
    const events = await h.as(cookie, 'GET', '/api/events?from=2026-09-01&to=2026-09-30');
    expect(events.statusCode).toBe(200);
    expect(events.json<{ title: string }[]>().some((e) => e.title === 'legacy')).toBe(false);
    expect((await h.as(cookie, 'GET', '/api/dashboard')).statusCode).toBe(200);
  });
});

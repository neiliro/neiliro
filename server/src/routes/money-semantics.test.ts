import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { runWithDb, today } from '../db/index.js';
import { shiftDays } from '../lib/dates.js';
import { runAutoCreate } from './budgets.js';

/*
  The money rules, as tests.

  These are the decisions where a wrong answer looks right: a balance is
  still a number, a discrepancy is still a figure, a rent charged twice is
  still a plausible row. Nothing crashes — the total just stops matching
  the bank, weeks later, with no way back to the change that caused it.

  Everything here was verified by hand during a QA pass first. That is the
  point of writing it down: a hand check is a moment, a test is a rule.
*/

let hub: Harness;
let cookie = '';
const INBOX = '00000000-0000-4000-8000-000000000001';

async function account(name: string, opening = 0): Promise<string> {
  const res = await hub.as(cookie, 'POST', '/api/accounts', {
    name,
    currency: 'EUR',
    opening_balance: opening,
  });
  return res.json<{ id: string }>().id;
}

async function balanceOf(name: string): Promise<number> {
  const list = (await hub.as(cookie, 'GET', '/api/accounts')).json<
    { name: string; balance: number; checked_balance: number | null; last_actual: number | null }[]
  >();
  return list.find((a) => a.name === name)!.balance;
}

async function accountRow(name: string) {
  const list = (await hub.as(cookie, 'GET', '/api/accounts')).json<
    { name: string; balance: number; checked_balance: number | null; last_actual: number | null }[]
  >();
  return list.find((a) => a.name === name)!;
}

async function spend(accountId: string, amount: number, on: string, categoryId?: string) {
  return hub.as(cookie, 'POST', '/api/transactions', {
    account_id: accountId,
    kind: 'expense',
    amount,
    occurred_on: on,
    ...(categoryId ? { category_id: categoryId } : {}),
  });
}

beforeAll(async () => {
  hub = await buildTestApp();
  cookie = hub.join('alice').cookie;
});

describe('balances are computed, never stored', () => {
  it('a backdated expense moves the balance now', async () => {
    const id = await account('Computed', 100_00);
    await spend(id, 30_00, '2026-08-10');
    expect(await balanceOf('Computed')).toBe(70_00);

    // Entered later, dated earlier — a stored balance would have missed it
    await spend(id, 5_00, '2026-07-01');
    expect(await balanceOf('Computed')).toBe(65_00);
  });

  it('editing an old amount recomputes rather than adjusts', async () => {
    const id = await account('Edited', 100_00);
    const tx = (await spend(id, 30_00, '2026-08-10')).json<{ id: string }>().id;
    await hub.as(cookie, 'PATCH', `/api/transactions/${tx}`, { amount: 10_00 });
    expect(await balanceOf('Edited')).toBe(90_00);
  });
});

describe('reconciliation compares against the balance at the moment of the check', () => {
  it('a transaction dated after the check does not move the discrepancy', async () => {
    const id = await account('Later', 100_00);
    await spend(id, 10_00, '2026-08-10');

    await hub.as(cookie, 'POST', `/api/accounts/${id}/reconcile`, {
      actual_balance: 88_00,
      checked_on: '2026-08-15',
    });
    const checked = (await accountRow('Later')).checked_balance;
    expect(checked).toBe(90_00);

    // The bank will process this one too; there is nothing to compare it against yet
    await spend(id, 7_77, '2026-08-20');
    expect((await accountRow('Later')).checked_balance).toBe(checked);
  });

  it('a forgotten expense dated before the check closes it', async () => {
    const id = await account('Forgotten', 100_00);
    await spend(id, 10_00, '2026-08-10');
    await hub.as(cookie, 'POST', `/api/accounts/${id}/reconcile`, {
      actual_balance: 88_00,
      checked_on: '2026-08-15',
    });
    expect((await accountRow('Forgotten')).checked_balance).toBe(90_00);

    // This is the workflow the feature exists for: see a gap, find what
    // was missed, enter it, watch the two sides meet
    await spend(id, 2_00, '2026-08-12');
    const row = await accountRow('Forgotten');
    expect(row.checked_balance).toBe(88_00);
    expect(row.last_actual).toBe(88_00);
  });

  it('a second check on the same day replaces the first, it does not add a twin', async () => {
    const id = await account('Twice', 100_00);
    for (const actual of [90_00, 80_00]) {
      await hub.as(cookie, 'POST', `/api/accounts/${id}/reconcile`, {
        actual_balance: actual,
        checked_on: '2026-08-15',
      });
    }
    const rows = hub.db
      .prepare('SELECT actual_balance FROM reconciliations WHERE account_id = ?')
      .all(id) as { actual_balance: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actual_balance).toBe(80_00);
  });
});

describe('subcategories are exactly one level deep', () => {
  let parent = '';
  let child = '';

  beforeAll(async () => {
    parent = (await hub.as(cookie, 'POST', '/api/categories', { name: 'Car', kind: 'expense' })).json<{
      id: string;
    }>().id;
    child = (
      await hub.as(cookie, 'POST', '/api/categories', {
        name: 'Fuel',
        kind: 'expense',
        parent_id: parent,
      })
    ).json<{ id: string }>().id;
  });

  it('refuses a child of a child', async () => {
    const res = await hub.as(cookie, 'POST', '/api/categories', {
      name: 'Diesel',
      kind: 'expense',
      parent_id: child,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses turning a parent into a subcategory', async () => {
    const res = await hub.as(cookie, 'PATCH', `/api/categories/${parent}`, { parent_id: child });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a category as its own parent', async () => {
    const res = await hub.as(cookie, 'PATCH', `/api/categories/${child}`, { parent_id: child });
    expect(res.statusCode).toBe(400);
  });
});

describe('a limit on a parent counts what its children spent', () => {
  it('adds the children in and keeps a separate limit on a child', async () => {
    const id = await account('Budgeted', 1000_00);
    const parent = (
      await hub.as(cookie, 'POST', '/api/categories', { name: 'Household', kind: 'expense' })
    ).json<{ id: string }>().id;
    const child = (
      await hub.as(cookie, 'POST', '/api/categories', {
        name: 'Cleaning',
        kind: 'expense',
        parent_id: parent,
      })
    ).json<{ id: string }>().id;

    await spend(id, 50_00, '2026-08-05', child);
    await spend(id, 20_00, '2026-08-06', parent);

    await hub.as(cookie, 'PUT', '/api/budgets', { category_id: parent, currency: 'EUR', amount: 150_00 });
    await hub.as(cookie, 'PUT', '/api/budgets', { category_id: child, currency: 'EUR', amount: 40_00 });

    const budgets = (await hub.as(cookie, 'GET', '/api/budgets?month=2026-08')).json<
      { category_name: string; limit_amount: number; spent: number }[]
    >();
    const byName = Object.fromEntries(budgets.map((b) => [b.category_name, b]));

    // The parent's own 20 plus the child's 50
    expect(byName.Household!.spent).toBe(70_00);
    expect(byName.Household!.limit_amount).toBe(150_00);
    // The child keeps its own, smaller limit alongside
    expect(byName.Cleaning!.spent).toBe(50_00);
    expect(byName.Cleaning!.limit_amount).toBe(40_00);
  });
});

describe('a recurring rule cannot charge the rent twice', () => {
  it('catches up once, and a restart does not double it', async () => {
    const id = await account('Rent from', 5000_00);
    const rule = await hub.as(cookie, 'POST', '/api/recurring', {
      title: 'Rent',
      kind: 'expense',
      start_on: '2026-05-01',
      recurrence_rule: 'FREQ=MONTHLY;INTERVAL=1',
      account_id: id,
      amount: 500_00,
      auto_create: true,
    });
    expect(rule.statusCode).toBe(201);

    const count = () =>
      (
        hub.db
          .prepare('SELECT count(*) AS n FROM transactions WHERE recurring_id IS NOT NULL')
          .get() as { n: number }
      ).n;

    const afterCreate = count();
    expect(afterCreate).toBeGreaterThan(0);

    // What happens on every boot. The unique index on rule + occurrence
    // date is the thing being tested; without it a machine that restarts
    // twice in a morning charges the rent twice.
    runWithDb(hub.db, () => runAutoCreate());
    runWithDb(hub.db, () => runAutoCreate());
    expect(count()).toBe(afterCreate);
  });
});

describe('currencies never mix', () => {
  it('a total is per currency, and there is no grand total', async () => {
    await hub.as(cookie, 'POST', '/api/accounts', {
      name: 'Dinars',
      currency: 'RSD',
      opening_balance: 5000_00,
    });
    const summary = (await hub.as(cookie, 'GET', '/api/money/summary?from=2026-08-01&to=2026-08-31')).json<{
      byCurrency: { currency: string }[];
    }>();
    const currencies = new Set(summary.byCurrency.map((row) => row.currency));
    for (const currency of currencies) expect(currency).toMatch(/^[A-Z]{3}$/);
  });
});

describe('tasks nest three levels deep and no further', () => {
  it('refuses a fourth level, a cycle, and a subtree that would not fit', async () => {
    const mk = async (title: string, parent?: string) =>
      (
        await hub.as(cookie, 'POST', '/api/tasks', {
          project_id: INBOX,
          title,
          ...(parent ? { parent_id: parent } : {}),
        })
      ).json<{ id: string }>().id;

    const story = await mk('story');
    const task = await mk('task', story);
    const subtask = await mk('subtask', task);

    const fourth = await hub.as(cookie, 'POST', '/api/tasks', {
      project_id: INBOX,
      title: 'too deep',
      parent_id: subtask,
    });
    expect(fourth.statusCode).toBe(400);

    // A two-deep subtree moved under a level-3 task would need five levels
    const otherRoot = await mk('other root');
    await mk('other child', otherRoot);
    const moved = await hub.as(cookie, 'PATCH', `/api/tasks/${otherRoot}`, { parent_id: subtask });
    expect(moved.statusCode).toBe(400);

    const cycle = await hub.as(cookie, 'PATCH', `/api/tasks/${story}`, { parent_id: subtask });
    expect(cycle.statusCode).toBe(400);
  });
});


/*
  The outlook: balance minus what is already spoken for before the next
  money arrives. Every test here uses a currency of its own — the hub
  shows every visible account, and the other tests in this file are all
  in euros.
*/
interface Outlook {
  currencies: {
    currency: string;
    balance: number;
    next_income: { recurring_id: string; title: string; date: string; amount: number } | null;
    until: string;
    bills: { title: string; date: string; amount: number }[];
    bills_total: number;
    left: number;
  }[];
}

async function accountIn(
  currency: string,
  name: string,
  opening: number,
  kind = 'card',
): Promise<string> {
  const res = await hub.as(cookie, 'POST', '/api/accounts', {
    name,
    currency,
    kind,
    opening_balance: opening,
  });
  return res.json<{ id: string }>().id;
}

async function recur(rule: Record<string, unknown>): Promise<void> {
  const res = await hub.as(cookie, 'POST', '/api/recurring', {
    recurrence_rule: 'FREQ=MONTHLY',
    ...rule,
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function outlookFor(currency: string): Promise<Outlook['currencies'][number]> {
  const res = await hub.as(cookie, 'GET', '/api/money/outlook');
  expect(res.statusCode).toBe(200);
  return res.json<Outlook>().currencies.find((c) => c.currency === currency)!;
}

describe('the outlook says what is left until the next money arrives', () => {
  it('stops at the next income, skips the piggy bank and internal moves', async () => {
    const on = (days: number) => shiftDays(today(), days);

    const main = await accountIn('CHF', 'Runway', 200_000);
    const piggy = await accountIn('CHF', 'Runway piggy', 50_000, 'savings');
    const spare = await accountIn('CHF', 'Runway cash', 0, 'cash');

    await recur({ title: 'Pay day', kind: 'income', amount: 300_000, account_id: main, start_on: on(10) });
    await recur({ title: 'Rent', kind: 'expense', amount: 95_000, account_id: main, start_on: on(3) });
    // Falls after the income: next month's problem, not this window's
    await recur({ title: 'Gym', kind: 'expense', amount: 5_000, account_id: main, start_on: on(20) });
    // Leaves the spendable pool even though it stays in the family
    await recur({
      title: 'Into the piggy bank', kind: 'transfer', amount: 10_000,
      account_id: main, to_account_id: piggy, to_amount: 10_000, start_on: on(5),
    });
    // Moves between two spendable accounts of the same currency: a wash
    await recur({
      title: 'Cash for the week', kind: 'transfer', amount: 20_000,
      account_id: main, to_account_id: spare, to_amount: 20_000, start_on: on(6),
    });

    const chf = await outlookFor('CHF');

    expect(chf.balance).toBe(200_000);
    // The rule id rides along so the browser can open an encrypted title (#219)
    expect(chf.next_income).toMatchObject({ title: 'Pay day', date: on(10), amount: 300_000 });
    expect(typeof chf.next_income?.recurring_id).toBe('string');
    expect(chf.bills.map((b) => b.title)).toEqual(['Rent', 'Into the piggy bank']);
    expect(chf.bills_total).toBe(105_000);
    expect(chf.left).toBe(95_000);
  });

  it('an income that has not arrived is still the next one, and today is still in the window', async () => {
    const on = (days: number) => shiftDays(today(), days);

    const main = await accountIn('SEK', 'Late salary', 100_000);
    // Due two days ago and never confirmed: the money is not here yet
    await recur({ title: 'Salary', kind: 'income', amount: 500_000, account_id: main, start_on: on(-2) });
    await recur({ title: 'Water', kind: 'expense', amount: 30_000, account_id: main, start_on: on(0) });
    await recur({ title: 'Later', kind: 'expense', amount: 70_000, account_id: main, start_on: on(1) });

    const sek = await outlookFor('SEK');

    expect(sek.next_income?.date).toBe(on(-2));
    // The window does not collapse into the past: today's bill counts,
    // tomorrow's waits for the next look
    expect(sek.until).toBe(today());
    expect(sek.bills.map((b) => b.title)).toEqual(['Water']);
    expect(sek.left).toBe(70_000);
  });

  it('forgets occurrences too old to be about the week ahead', async () => {
    const on = (days: number) => shiftDays(today(), days);

    const main = await accountIn('DKK', 'Long forgotten', 400_000);
    // Never confirmed since spring: stale bookkeeping, not the next money
    await recur({ title: 'Old salary', kind: 'income', amount: 500_000, account_id: main, start_on: on(-40) });
    await recur({ title: 'Old rent', kind: 'expense', amount: 100_000, account_id: main, start_on: on(-40) });

    const dkk = await outlookFor('DKK');

    // The monthly rules step forward: what counts is the occurrence
    // inside the window, not the ones nobody confirmed since spring.
    // Asserted relationally — months are not all the same length.
    expect(dkk.next_income!.date > today()).toBe(true);
    expect(dkk.bills).toHaveLength(1);
    expect(dkk.bills[0]!.date >= on(-7)).toBe(true);
    expect(dkk.left).toBe(300_000);
  });

  it('with no income scheduled it still shows the month ahead', async () => {
    const on = (days: number) => shiftDays(today(), days);

    const main = await accountIn('NOK', 'No salary here', 90_000);
    await recur({ title: 'Storage unit', kind: 'expense', amount: 20_000, account_id: main, start_on: on(4) });
    await recur({ title: 'Far away', kind: 'expense', amount: 60_000, account_id: main, start_on: on(45) });

    const nok = await outlookFor('NOK');

    expect(nok.next_income).toBeNull();
    expect(nok.until).toBe(on(30));
    expect(nok.bills.map((b) => b.title)).toEqual(['Storage unit']);
    expect(nok.left).toBe(70_000);
  });
});

describe('a transfer into a personal account shows the other member an amount and nothing else', () => {
  it('masks the destination — name, id, owner, shared flag — for the member who cannot see it', async () => {
    const bob = hub.join('bob').cookie;
    const joint = await account('Joint for transfers', 100_000);
    const wallet = (
      await hub.as(bob, 'POST', '/api/accounts', { name: 'Bob wallet', currency: 'EUR', shared: false })
    ).json<{ id: string }>().id;
    const moved = await hub.as(bob, 'POST', '/api/transactions', {
      kind: 'transfer',
      occurred_on: '2026-09-09',
      account_id: joint,
      to_account_id: wallet,
      amount: 2_000,
      to_amount: 2_000,
    });
    expect(moved.statusCode).toBe(201);

    type Row = Record<string, unknown> & { kind: string };
    const rows = (cookieValue: string) =>
      hub.as(cookieValue, 'GET', `/api/transactions?account_id=${joint}`).then((r) =>
        r.json<Row[]>().filter((t) => t.kind === 'transfer'),
      );

    // Alice, who does not own the wallet: the amount, and a wall
    const [alicesView] = await rows(cookie);
    expect(alicesView).toMatchObject({
      amount: 2_000,
      to_amount: 2_000,
      to_currency: 'EUR',
      to_account_name: 'Personal account',
      to_account_id: null,
      to_owner: null,
      to_shared: null,
    });
    // Bob, the owner: the real thing
    const [bobsView] = await rows(bob);
    expect(bobsView).toMatchObject({ to_account_id: wallet, to_account_name: 'Bob wallet', to_shared: 0 });

    // The mirror case: money arriving on the shared account from Bob's wallet
    await hub.as(bob, 'POST', '/api/transactions', {
      kind: 'transfer',
      occurred_on: '2026-09-09',
      account_id: wallet,
      to_account_id: joint,
      amount: 500,
      to_amount: 500,
    });
    const incoming = (await rows(cookie)).find((t) => t.amount === 500)!;
    expect(incoming).toMatchObject({ account_name: 'Personal account', account_owner: null, note: null });
  });
});

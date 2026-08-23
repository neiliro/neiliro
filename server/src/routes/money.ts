import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { currentTenant, db, id, now, today } from '../db/index.js';
import { shiftDays } from '../lib/dates.js';
import { dueOccurrences } from './budgets.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An account is visible if it is shared or belongs to the asker.
 * All money privacy rests on this rule from here on: a transaction has
 * no privacy flag of its own — it inherits it from the account.
 */
const ACCOUNT_VISIBLE = '(a.shared = 1 OR a.owner_id = ?)';

/**
 * The balance is computed, not stored: opening balance plus movements.
 * A stored balance drifts from history after any backdated edit — so the
 * expression lives here once, for everyone who needs a balance.
 */
const BALANCE_SQL = `a.opening_balance
  - coalesce((SELECT sum(t.amount) FROM transactions t
       WHERE t.account_id = a.id AND t.kind = 'expense'), 0)
  + coalesce((SELECT sum(t.amount) FROM transactions t
       WHERE t.account_id = a.id AND t.kind = 'income'), 0)
  - coalesce((SELECT sum(t.amount) FROM transactions t
       WHERE t.account_id = a.id AND t.kind = 'transfer'), 0)
  + coalesce((SELECT sum(t.to_amount) FROM transactions t
       WHERE t.to_account_id = a.id AND t.kind = 'transfer'), 0)`;

const accountInput = z.object({
  name: z.string().min(1, 'Enter an account name').max(100),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'The currency code is three capital letters, e.g. RSD or EUR'),
  kind: z.enum(['cash', 'card', 'savings']).optional(),
  opening_balance: z.number().int().optional(),
  shared: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const categoryInput = z.object({
  name: z.string().min(1, 'Enter a category name').max(100),
  kind: z.enum(['expense', 'income']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parent_id: z.string().uuid().nullable().optional(),
});

/**
 * The parent must be an existing category of the same kind and itself be
 * top-level — the hierarchy never grows deeper than one level.
 * Returns the error text, or null if all is well.
 */
function parentProblem(parentId: string, kind: string): string | null {
  const parent = db
    .prepare('SELECT kind, parent_id, archived_at FROM categories WHERE id = ?')
    .get(parentId) as { kind: string; parent_id: string | null; archived_at: string | null } | undefined;
  if (!parent || parent.archived_at) return 'Parent category not found';
  if (parent.kind !== kind) return 'Parent must be a category of the same kind';
  if (parent.parent_id) return 'A subcategory cannot be a parent';
  return null;
}

const txBase = z.object({
  kind: z.enum(['expense', 'income', 'transfer']),
  occurred_on: z.string().regex(DATE, 'Date must be YYYY-MM-DD'),
  account_id: z.string().uuid(),
  amount: z.number().int().positive('Amount must be greater than zero'),
  to_account_id: z.string().uuid().nullable().optional(),
  to_amount: z.number().int().positive().nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  place: z.string().max(200).nullable().optional(),
});

type TxDraft = Partial<z.infer<typeof txBase>>;

const transferHasSecondSide = (v: TxDraft) =>
  v.kind !== 'transfer' || Boolean(v.to_account_id && v.to_amount);

const secondSideOnlyForTransfer = (v: TxDraft) =>
  v.kind === undefined || v.kind === 'transfer' || (!v.to_account_id && !v.to_amount);

const notSameAccount = (v: TxDraft) =>
  !v.to_account_id || v.account_id !== v.to_account_id;

const txInput = txBase
  .refine(transferHasSecondSide, {
    message: 'A transfer needs a destination account and a received amount',
    path: ['to_account_id'],
  })
  .refine(secondSideOnlyForTransfer, {
    message: 'Only a transfer has a second side',
    path: ['to_account_id'],
  })
  .refine(notSameAccount, {
    message: 'A transfer to the same account makes no sense',
    path: ['to_account_id'],
  });

const txPatch = txBase.partial().refine(notSameAccount, {
  message: 'A transfer to the same account makes no sense',
  path: ['to_account_id'],
});

interface AccountRow {
  id: string;
  name: string;
  currency: string;
  shared: number;
  owner_id: string | null;
}

function visibleAccountIds(userId: string): Set<string> {
  const rows = db
    .prepare(`SELECT a.id FROM accounts a WHERE ${ACCOUNT_VISIBLE}`)
    .all(userId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

export async function registerMoneyRoutes(app: FastifyInstance): Promise<void> {
  // ── Accounts ────────────────────────────────────────────────────────────

  app.get('/api/accounts', (req) => {
    const { archived } = z
      .object({ archived: z.enum(['true', 'false']).optional() })
      .parse(req.query);
    const clause = archived === 'true' ? 'IS NOT NULL' : 'IS NULL';

    const rows = db
      .prepare(
        `SELECT a.*, u.name AS owner_name,
                ${BALANCE_SQL} AS balance,
                (SELECT count(*) FROM transactions t
                  WHERE t.account_id = a.id OR t.to_account_id = a.id) AS tx_count,
                (SELECT r.actual_balance FROM reconciliations r
                  WHERE r.account_id = a.id ORDER BY r.checked_on DESC LIMIT 1) AS last_actual,
                (SELECT r.checked_on FROM reconciliations r
                  WHERE r.account_id = a.id ORDER BY r.checked_on DESC LIMIT 1) AS last_checked_on,
                (SELECT r.created_at FROM reconciliations r
                  WHERE r.account_id = a.id ORDER BY r.checked_on DESC LIMIT 1) AS last_checked_at
           FROM accounts a
           LEFT JOIN users u ON u.id = a.owner_id
          WHERE ${ACCOUNT_VISIBLE} AND a.archived_at ${clause}
          ORDER BY a.shared DESC, a.position, a.name`,
      )
      .all(req.user?.id ?? '') as (AccountRow & {
      balance: number;
      last_actual: number | null;
      last_checked_on: string | null;
      last_checked_at: string | null;
      opening_balance: number;
    })[];

    /**
     * The balance as of reconciliation — for the discrepancy. Comparing the
     * bank's actual against the current balance won't do: every transaction
     * after the reconciliation would shift the discrepancy by its amount,
     * and the account would need re-reconciling after every purchase.
     *
     * "As of reconciliation" means transactions on earlier dates plus
     * same-day ones entered before it (dates carry no time, we tell them
     * apart by created_at). Both quantities are computed, not stored:
     * a missed expense entered retroactively recomputes the balance as of
     * reconciliation and closes the discrepancy — exactly the workflow
     * reconciliation exists for.
     */
    const checkedBalance = db.prepare(
      `SELECT
         coalesce(sum(CASE
           WHEN t.account_id = @acc AND t.kind IN ('expense', 'transfer') THEN -t.amount
           WHEN t.account_id = @acc AND t.kind = 'income' THEN t.amount
           ELSE 0 END), 0)
         + coalesce(sum(CASE
             WHEN t.to_account_id = @acc AND t.kind = 'transfer' THEN t.to_amount
             ELSE 0 END), 0) AS movements
        FROM transactions t
       WHERE (t.account_id = @acc OR t.to_account_id = @acc)
         AND (t.occurred_on < @day OR (t.occurred_on = @day AND t.created_at <= @at))`,
    );

    return rows.map((a) => ({
      ...a,
      checked_balance:
        a.last_checked_on === null
          ? null
          : a.opening_balance +
            (
              checkedBalance.get({
                acc: a.id,
                day: a.last_checked_on,
                at: a.last_checked_at,
              }) as { movements: number }
            ).movements,
    }));
  });

  app.post('/api/accounts', (req, reply) => {
    const parsed = accountInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;
    const personal = d.shared === false;
    const accountId = id();

    db.prepare(
      `INSERT INTO accounts (id, name, currency, kind, opening_balance, owner_id, shared, color,
                             position, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT coalesce(max(position), 0) + 1 FROM accounts), ?)`,
    ).run(
      accountId,
      d.name.trim(),
      d.currency,
      d.kind ?? 'card',
      d.opening_balance ?? 0,
      personal ? (req.user?.id ?? null) : null,
      personal ? 0 : 1,
      d.color ?? '#1F6E8C',
      req.user?.id ?? null,
    );
    return reply.code(201).send(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
  });

  app.patch('/api/accounts/:id', (req, reply) => {
    const { id: accountId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = accountInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const account = db
      .prepare(`SELECT a.* FROM accounts a WHERE a.id = ? AND ${ACCOUNT_VISIBLE}`)
      .get(accountId, req.user?.id ?? '') as AccountRow | undefined;
    if (!account) return reply.code(404).send({ error: 'Account not found' });
    if (account.owner_id && account.owner_id !== req.user?.id) {
      return reply.code(403).send({ error: 'This account belongs to someone else' });
    }

    const d = parsed.data;
    // Changing the currency of an account with transactions would turn history into mush
    if (d.currency && d.currency !== account.currency) {
      const used = (
        db
          .prepare(
            'SELECT count(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?',
          )
          .get(accountId, accountId) as { n: number }
      ).n;
      if (used > 0) {
        return reply
          .code(409)
          .send({ error: 'The account has transactions — the currency cannot change, create a new account' });
      }
    }

    const fields: [string, unknown][] = [];
    if (d.name !== undefined) fields.push(['name', d.name.trim()]);
    if (d.currency !== undefined) fields.push(['currency', d.currency]);
    if (d.kind !== undefined) fields.push(['kind', d.kind]);
    if (d.opening_balance !== undefined) fields.push(['opening_balance', d.opening_balance]);
    if (d.color !== undefined) fields.push(['color', d.color]);
    if (d.shared !== undefined) {
      fields.push(['shared', d.shared ? 1 : 0]);
      fields.push(['owner_id', d.shared ? null : (req.user?.id ?? null)]);
    }
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });

    db.prepare(
      `UPDATE accounts SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ?
        WHERE id = ?`,
    ).run(...fields.map(([, v]) => v as string | number | null), now(), accountId);

    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  });

  app.post('/api/accounts/:id/archive', (req, reply) => {
    const { id: accountId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const account = db
      .prepare(`SELECT a.archived_at FROM accounts a WHERE a.id = ? AND ${ACCOUNT_VISIBLE}`)
      .get(accountId, req.user?.id ?? '') as { archived_at: string | null } | undefined;
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const archived = account.archived_at ? null : now();
    db.prepare('UPDATE accounts SET archived_at = ?, updated_at = ? WHERE id = ?').run(
      archived,
      now(),
      accountId,
    );
    return { archived: Boolean(archived) };
  });

  app.delete('/api/accounts/:id', (req, reply) => {
    const { id: accountId } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Same lookup as archive above. Without it this route deleted by id
    // alone: anyone could remove an empty account they could not even see.
    const visible = db
      .prepare(`SELECT a.id FROM accounts a WHERE a.id = ? AND ${ACCOUNT_VISIBLE}`)
      .get(accountId, req.user?.id ?? '');
    if (!visible) return reply.code(404).send({ error: 'Account not found' });

    const count = (
      db
        .prepare('SELECT count(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?')
        .get(accountId, accountId) as { n: number }
    ).n;
    if (count > 0) {
      return reply.code(409).send({
        error:
          `The account has ${count} ${count === 1 ? 'transaction' : 'transactions'}. ` +
          'Deleting the account erases them too — archive it instead',
      });
    }
    const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Account not found' });
    return { ok: true };
  });

  /** Reconciliation against the bank: the actual balance and the discrepancy. */
  app.post('/api/accounts/:id/reconcile', (req, reply) => {
    const { id: accountId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = z
      .object({
        checked_on: z.string().regex(DATE),
        actual_balance: z.number().int(),
        note: z.string().max(300).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter the date and the actual balance' });

    const visible = db
      .prepare(`SELECT a.id FROM accounts a WHERE a.id = ? AND ${ACCOUNT_VISIBLE}`)
      .get(accountId, req.user?.id ?? '');
    if (!visible) return reply.code(404).send({ error: 'Account not found' });

    // A repeat reconciliation on the same day updates the previous one
    // instead of spawning twins: what matters is the actual balance on
    // the date, not the history of attempts
    db.prepare(
      `INSERT INTO reconciliations (id, account_id, checked_on, actual_balance, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, checked_on) DO UPDATE SET
         actual_balance = excluded.actual_balance,
         note = excluded.note,
         created_by = excluded.created_by,
         created_at = datetime('now')`,
    ).run(
      id(),
      accountId,
      parsed.data.checked_on,
      parsed.data.actual_balance,
      parsed.data.note ?? null,
      req.user?.id ?? null,
    );
    return { ok: true };
  });

  // ── Categories ──────────────────────────────────────────────────────────

  app.get('/api/categories', (req) => {
    const { kind } = z
      .object({ kind: z.enum(['expense', 'income']).optional() })
      .parse(req.query);
    const clause = kind ? 'AND kind = ?' : '';
    const args = kind ? [kind] : [];
    return db
      .prepare(
        `SELECT * FROM categories WHERE archived_at IS NULL ${clause}
          ORDER BY kind, position, name`,
      )
      .all(...args);
  });

  app.post('/api/categories', (req, reply) => {
    const parsed = categoryInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    if (parsed.data.parent_id) {
      const problem = parentProblem(parsed.data.parent_id, parsed.data.kind);
      if (problem) return reply.code(400).send({ error: problem });
    }
    const categoryId = id();
    db.prepare(
      `INSERT INTO categories (id, name, kind, color, position, parent_id)
       VALUES (?, ?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM categories), ?)`,
    ).run(
      categoryId,
      parsed.data.name.trim(),
      parsed.data.kind,
      parsed.data.color ?? '#5A6A74',
      parsed.data.parent_id ?? null,
    );
    return reply.code(201).send(db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId));
  });

  app.patch('/api/categories/:id', (req, reply) => {
    const { id: categoryId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = categoryInput.partial().omit({ kind: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the fields' });

    const fields: [string, unknown][] = [];
    if (parsed.data.name !== undefined) fields.push(['name', parsed.data.name.trim()]);
    if (parsed.data.color !== undefined) fields.push(['color', parsed.data.color]);
    if (parsed.data.parent_id !== undefined) {
      if (parsed.data.parent_id) {
        if (parsed.data.parent_id === categoryId) {
          return reply.code(400).send({ error: 'A category cannot be its own parent' });
        }
        const current = db
          .prepare('SELECT kind FROM categories WHERE id = ?')
          .get(categoryId) as { kind: string } | undefined;
        if (!current) return reply.code(404).send({ error: 'Category not found' });
        const problem = parentProblem(parsed.data.parent_id, current.kind);
        if (problem) return reply.code(400).send({ error: problem });
        const children = (
          db
            .prepare('SELECT count(*) AS n FROM categories WHERE parent_id = ?')
            .get(categoryId) as { n: number }
        ).n;
        if (children > 0) {
          return reply
            .code(400)
            .send({ error: 'This category has subcategories — detach them first' });
        }
      }
      fields.push(['parent_id', parsed.data.parent_id]);
    }
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });

    const result = db
      .prepare(`UPDATE categories SET ${fields.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...fields.map(([, v]) => v as string | null), categoryId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Category not found' });
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  });

  app.delete('/api/categories/:id', (req) => {
    const { id: categoryId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const used = (
      db.prepare('SELECT count(*) AS n FROM transactions WHERE category_id = ?').get(categoryId) as {
        n: number;
      }
    ).n;
    if (used > 0) {
      // A category with history is hidden, not deleted: otherwise past
      // transactions lose their labeling and past months' reports change
      db.prepare('UPDATE categories SET archived_at = ? WHERE id = ?').run(now(), categoryId);
      return { archived: true, used };
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
    return { archived: false, used: 0 };
  });

  // ── Transactions ────────────────────────────────────────────────────────

  app.get('/api/transactions', (req) => {
    const q = z
      .object({
        from: z.string().regex(DATE).optional(),
        to: z.string().regex(DATE).optional(),
        account_id: z.string().uuid().optional(),
        category_id: z.string().uuid().optional(),
        kind: z.enum(['expense', 'income', 'transfer']).optional(),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);

    const userId = req.user?.id ?? '';
    const where: string[] = [
      // A transaction is visible if at least one of its sides is
      `(a.shared = 1 OR a.owner_id = ? OR b.shared = 1 OR b.owner_id = ?)`,
    ];
    const args: unknown[] = [userId, userId];

    if (q.from) {
      where.push('t.occurred_on >= ?');
      args.push(q.from);
    }
    if (q.to) {
      where.push('t.occurred_on <= ?');
      args.push(q.to);
    }
    if (q.account_id) {
      where.push('(t.account_id = ? OR t.to_account_id = ?)');
      args.push(q.account_id, q.account_id);
    }
    if (q.category_id) {
      where.push('t.category_id = ?');
      args.push(q.category_id);
    }
    if (q.kind) {
      where.push('t.kind = ?');
      args.push(q.kind);
    }
    if (q.search) {
      where.push("(ci_contains(coalesce(t.note, ''), ?) OR ci_contains(coalesce(t.place, ''), ?))");
      args.push(q.search, q.search);
    }

    const rows = db
      .prepare(
        `SELECT t.*,
                a.name AS account_name, a.currency AS currency, a.color AS account_color,
                a.shared AS account_shared, a.owner_id AS account_owner,
                b.name AS to_account_name, b.currency AS to_currency,
                b.shared AS to_shared, b.owner_id AS to_owner,
                c.name AS category_name, c.color AS category_color,
                u.name AS author_name,
                (SELECT count(*) FROM attachments att WHERE att.transaction_id = t.id) AS receipts
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN accounts b ON b.id = t.to_account_id
           LEFT JOIN categories c ON c.id = t.category_id
           LEFT JOIN users u ON u.id = t.created_by
          WHERE ${where.join(' AND ')}
          ORDER BY t.occurred_on DESC, t.created_at DESC
          LIMIT ?`,
      )
      .all(...args, q.limit ?? 100) as Record<string, unknown>[];

    const visible = visibleAccountIds(userId);

    // A transfer to someone else's personal account shows its amount but
    // not the account name: money leaving a shared account can't be
    // hidden, or the balance would be wrong
    return rows.map((row) => {
      const masked = { ...row };
      if (row['to_account_id'] && !visible.has(row['to_account_id'] as string)) {
        masked['to_account_name'] = 'Personal account';
      }
      if (!visible.has(row['account_id'] as string)) {
        masked['account_name'] = 'Personal account';
        masked['note'] = null;
        masked['place'] = null;
        masked['category_name'] = null;
      }
      return masked;
    });
  });

  app.post('/api/transactions', (req, reply) => {
    const parsed = txInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;
    const visible = visibleAccountIds(req.user?.id ?? '');

    if (!visible.has(d.account_id)) return reply.code(400).send({ error: 'Account not found' });
    if (d.to_account_id && !visible.has(d.to_account_id)) {
      return reply.code(400).send({ error: 'Destination account not found' });
    }

    if (d.category_id) {
      const category = db
        .prepare('SELECT kind FROM categories WHERE id = ?')
        .get(d.category_id) as { kind: string } | undefined;
      if (!category) return reply.code(400).send({ error: 'Category not found' });
      if (d.kind === 'transfer') {
        return reply.code(400).send({ error: 'A transfer has no category' });
      }
      if (category.kind !== d.kind) {
        return reply
          .code(400)
          .send({ error: 'Wrong category kind: expenses and income use different ones' });
      }
    }

    const txId = id();
    db.prepare(
      `INSERT INTO transactions (id, kind, occurred_on, account_id, amount, to_account_id,
                                 to_amount, category_id, note, place, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      txId,
      d.kind,
      d.occurred_on,
      d.account_id,
      d.amount,
      d.to_account_id ?? null,
      d.to_amount ?? null,
      d.category_id ?? null,
      d.note ?? null,
      d.place ?? null,
      req.user?.id ?? null,
    );
    return reply.code(201).send(db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId));
  });

  app.patch('/api/transactions/:id', (req, reply) => {
    const { id: txId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = txPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const visible = visibleAccountIds(req.user?.id ?? '');
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as
      | { account_id: string; kind: string }
      | undefined;
    if (!tx || !visible.has(tx.account_id)) {
      return reply.code(404).send({ error: 'Transaction not found' });
    }

    const d = parsed.data;
    const fields: [string, unknown][] = [];
    for (const key of ['occurred_on', 'amount', 'note', 'place', 'to_amount'] as const) {
      if (d[key] !== undefined) fields.push([key, d[key]]);
    }
    // The category is validated the same as on create: otherwise an edit
    // could hang an income category on an expense, skewing category reports
    if (d.category_id !== undefined) {
      if (d.category_id) {
        if (tx.kind === 'transfer') {
          return reply.code(400).send({ error: 'A transfer has no category' });
        }
        const category = db
          .prepare('SELECT kind FROM categories WHERE id = ?')
          .get(d.category_id) as { kind: string } | undefined;
        if (!category) return reply.code(400).send({ error: 'Category not found' });
        if (category.kind !== tx.kind) {
          return reply
            .code(400)
            .send({ error: 'Wrong category kind: expenses and income use different ones' });
        }
      }
      fields.push(['category_id', d.category_id]);
    }
    if (d.account_id !== undefined) {
      if (!visible.has(d.account_id)) return reply.code(400).send({ error: 'Account not found' });
      fields.push(['account_id', d.account_id]);
    }
    if (d.to_account_id !== undefined) {
      if (d.to_account_id && !visible.has(d.to_account_id)) {
        return reply.code(400).send({ error: 'Destination account not found' });
      }
      fields.push(['to_account_id', d.to_account_id]);
    }
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });

    db.prepare(
      `UPDATE transactions SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ?
        WHERE id = ?`,
    ).run(...fields.map(([, v]) => v as string | number | null), now(), txId);

    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  });

  app.delete('/api/transactions/:id', async (req, reply) => {
    const { id: txId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const visible = visibleAccountIds(req.user?.id ?? '');
    const tx = db.prepare('SELECT account_id FROM transactions WHERE id = ?').get(txId) as
      | { account_id: string }
      | undefined;
    if (!tx || !visible.has(tx.account_id)) {
      return reply.code(404).send({ error: 'Transaction not found' });
    }

    // Rows go away via cascade; receipt files must be removed by hand
    const receipts = db
      .prepare('SELECT storage_path FROM attachments WHERE transaction_id = ?')
      .all(txId) as { storage_path: string }[];

    db.prepare('DELETE FROM transactions WHERE id = ?').run(txId);

    for (const file of receipts) {
      await unlink(resolve(currentTenant().attachmentsDir, file.storage_path)).catch(() => {});
    }
    return { ok: true };
  });

  /** A transaction's receipts — for the detail card. */
  app.get('/api/transactions/:id/attachments', (req, reply) => {
    const { id: txId } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!visibleAccountIds(req.user?.id ?? '').has(
      (db.prepare('SELECT account_id FROM transactions WHERE id = ?').get(txId) as
        | { account_id: string }
        | undefined)?.account_id ?? '',
    )) {
      return reply.code(404).send({ error: 'Transaction not found' });
    }
    return db
      .prepare(
        `SELECT id, filename, mime, size_bytes,
                CASE WHEN mime LIKE 'image/%' THEN 1 ELSE 0 END AS is_image
           FROM attachments WHERE transaction_id = ? ORDER BY created_at`,
      )
      .all(txId);
  });

  // ── Monthly summary ─────────────────────────────────────────────────────

  /** Totals per currency, separately: no grand total without an exchange rate. */
  app.get('/api/money/summary', (req, reply) => {
    const parsed = z
      .object({ from: z.string().regex(DATE), to: z.string().regex(DATE) })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Period boundaries are required' });

    const userId = req.user?.id ?? '';
    const { from, to } = parsed.data;

    const byCurrency = db
      .prepare(
        `SELECT a.currency, t.kind, sum(t.amount) AS total
           FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE ${ACCOUNT_VISIBLE} AND t.occurred_on BETWEEN ? AND ?
            AND t.kind IN ('expense','income')
          GROUP BY a.currency, t.kind`,
      )
      .all(userId, from, to) as { currency: string; kind: string; total: number }[];

    const byCategory = db
      .prepare(
        `SELECT a.currency, c.id AS category_id, c.name AS category_name, c.color,
                c.kind, c.parent_id, sum(t.amount) AS total, count(*) AS count
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN categories c ON c.id = t.category_id
          WHERE ${ACCOUNT_VISIBLE} AND t.occurred_on BETWEEN ? AND ?
            AND t.kind IN ('expense','income')
          GROUP BY a.currency, c.id
          ORDER BY total DESC`,
      )
      .all(userId, from, to);

    return { from, to, byCurrency, byCategory };
  });

  // ── Outlook: what is left to live on ────────────────────────────────────

  /*
    The question the accounts screen answers badly: not "how much is
    there" but "how much of it is already spoken for before the next
    money arrives".

    Per currency, because nothing here is ever converted — a euro balance
    says nothing about a dinar salary. Spendable only: a piggy bank is
    not this month's money, the same rule the accounts screen uses.

    The next income is whichever recurring income comes first, by its own
    title — this hub has no notion of a salary, only of money that
    arrives on a schedule.

    The window opens a week before today, not at today: a salary can run
    a few days late and an unpaid bill is still money about to leave, and
    both belong in the count. Older unconfirmed occurrences do not —
    those are stale bookkeeping (the pending list in Money is where they
    get resolved), and left unbounded a rule nobody ever confirms drags
    months of ghosts onto the dashboard.
  */
  app.get('/api/money/outlook', (req) => {
    const userId = req.user?.id ?? '';
    const day = today();
    // Far enough ahead that a monthly income always falls inside, near
    // enough that expanding every rule stays cheap.
    const horizon = shiftDays(day, 62);
    // With no income scheduled at all, the bills of the coming month are
    // still worth seeing — there is simply nothing to count down to.
    const WINDOW_WITHOUT_INCOME = 30;
    // How far back a late payment is still part of what lies ahead
    const GRACE_DAYS = 7;
    const from = shiftDays(day, -GRACE_DAYS);

    const accounts = db
      .prepare(
        `SELECT a.id, a.currency, a.kind, ${BALANCE_SQL} AS balance
           FROM accounts a
          WHERE ${ACCOUNT_VISIBLE} AND a.archived_at IS NULL`,
      )
      .all(userId) as { id: string; currency: string; kind: string; balance: number }[];

    const byId = new Map(accounts.map((a) => [a.id, a]));
    const balances = new Map<string, number>();
    for (const a of accounts) {
      if (a.kind === 'savings') continue;
      balances.set(a.currency, (balances.get(a.currency) ?? 0) + a.balance);
    }

    const dues = dueOccurrences(userId, horizon);

    /*
      A transfer only leaves the pool when it lands outside it: moving
      money between two spendable accounts of the same currency changes
      nothing about what the family can spend, while the standing order
      into the piggy bank very much does. A destination this person
      cannot see counts as leaving — for them, it has left.
    */
    const isOutflow = (due: (typeof dues)[number], currency: string): boolean => {
      if (due.kind === 'expense') return true;
      if (due.kind !== 'transfer') return false;
      const dest = due.to_account_id ? byId.get(due.to_account_id) : undefined;
      return !dest || dest.kind === 'savings' || dest.currency !== currency;
    };

    const currencies = [...balances.entries()]
      .map(([currency, balance]) => {
        const mine = dues.filter((d) => d.currency === currency && d.occurred_on >= from);
        // dueOccurrences returns them in date order, so the first income is the next one
        const income = mine.find((d) => d.kind === 'income') ?? null;
        // A late income must not shrink the window to nothing: bills
        // falling today are still bills to pay before it arrives.
        const until = income
          ? income.occurred_on > day
            ? income.occurred_on
            : day
          : shiftDays(day, WINDOW_WITHOUT_INCOME);

        const bills = mine
          .filter((d) => d.occurred_on <= until && isOutflow(d, currency))
          .map((d) => ({
            recurring_id: d.recurring_id,
            title: d.title,
            date: d.occurred_on,
            amount: d.amount,
          }));
        const bills_total = bills.reduce((sum, b) => sum + b.amount, 0);

        return {
          currency,
          balance,
          next_income: income
            ? { title: income.title, date: income.occurred_on, amount: income.amount }
            : null,
          until,
          bills,
          bills_total,
          left: balance - bills_total,
        };
      })
      .sort((a, b) => b.balance - a.balance);

    return { today: day, currencies };
  });
}

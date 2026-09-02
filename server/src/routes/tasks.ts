import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';
import { isValidRecurrence, occurrenceAfter } from '../lib/recurrence.js';

const STATUSES = ['backlog', 'todo', 'in_progress', 'done', 'cancelled'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/*
  The list is capped, because on the hosted service one process serves
  every family: a single family with tens of thousands of tasks made
  `GET /api/tasks` load the whole table and serialise it on the shared
  event loop, and unrelated families measurably waited for it. The cap is
  far above any real household and the ORDER BY keeps the rows anyone
  actually looks at, so nothing changes in practice — it only removes the
  ceiling. `/api/transactions` has been capped the same way from the start.
*/
const LIST_LIMIT = 1000;
const LIST_LIMIT_MAX = 2000;

/*
  One row's shape, shared by the list and by the single-task route so the
  two can never drift apart — the client treats them interchangeably.
*/
const TASK_SELECT = `SELECT t.*, p.title AS project_title, p.color AS project_color,
                u.name AS assignee_name, u.color AS assignee_color,
                (SELECT count(*) FROM tasks c WHERE c.parent_id = t.id) AS child_count,
                (SELECT count(*) FROM tasks c
                  WHERE c.parent_id = t.id AND c.status = 'done') AS child_done
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           LEFT JOIN users u ON u.id = t.assignee_id`;

interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  level: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  assignee_id: string | null;
  recurrence_rule: string | null;
  recurrence_parent_id: string | null;
  position: number;
}

const createInput = z.object({
  project_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1, 'The task needs a title').max(300),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: z.string().regex(DATE, 'Date must be YYYY-MM-DD').nullable().optional(),
  expected_date: z.string().regex(DATE, 'Date must be YYYY-MM-DD').nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  recurrence_rule: z.string().max(100).nullable().optional(),
});

const patchInput = createInput.partial().omit({ project_id: true });

/** Subtree depth relative to the task itself: 0 — no children. */
function subtreeDepth(taskId: string): number {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT id, 0 FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, sub.depth + 1 FROM tasks t JOIN sub ON t.parent_id = sub.id
       )
       SELECT max(depth) AS d FROM sub`,
    )
    .get(taskId) as { d: number | null };
  return row.d ?? 0;
}

function isDescendant(candidateId: string, ofTaskId: string): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
       )
       SELECT 1 AS hit FROM sub WHERE id = ? LIMIT 1`,
    )
    .get(ofTaskId, candidateId) as { hit: number } | undefined;
  return Boolean(row);
}

function shiftSubtreeLevels(taskId: string, delta: number): void {
  if (delta === 0) return;
  db.prepare(
    `WITH RECURSIVE sub(id) AS (
       SELECT id FROM tasks WHERE id = ?
       UNION ALL
       SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id
     )
     UPDATE tasks SET level = level + ? WHERE id IN (SELECT id FROM sub)`,
  ).run(taskId, delta);
}

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks', (req) => {
    const q = z
      .object({
        project_id: z.string().uuid().optional(),
        status: z.string().optional(),
        assignee_id: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        due_before: z.string().regex(DATE).optional(),
        due_after: z.string().regex(DATE).optional(),
        include_done: z.enum(['true', 'false']).optional(),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
      })
      .parse(req.query);

    const where: string[] = [];
    const args: unknown[] = [];

    if (q.project_id) {
      where.push('t.project_id = ?');
      args.push(q.project_id);
    }
    if (q.status) {
      const list = q.status.split(',').filter((s) => (STATUSES as readonly string[]).includes(s));
      if (list.length) {
        where.push(`t.status IN (${list.map(() => '?').join(',')})`);
        args.push(...list);
      }
    } else if (q.include_done !== 'true') {
      where.push("t.status NOT IN ('done','cancelled')");
    }
    if (q.assignee_id) {
      where.push(q.assignee_id === 'none' ? 't.assignee_id IS NULL' : 't.assignee_id = ?');
      if (q.assignee_id !== 'none') args.push(q.assignee_id);
    }
    if (q.priority) {
      where.push('t.priority = ?');
      args.push(q.priority);
    }
    // Date windows (the calendar fetch) go by the effective date: when an
    // expected completion is set, that is the day the task actually lives on
    if (q.due_before) {
      where.push('coalesce(t.expected_date, t.due_date) <= ?');
      args.push(q.due_before);
    }
    if (q.due_after) {
      where.push('coalesce(t.expected_date, t.due_date) >= ?');
      args.push(q.due_after);
    }
    if (q.search) {
      where.push('ci_contains(t.title, ?)');
      args.push(q.search);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db
      .prepare(
        `${TASK_SELECT}
           ${clause}
          ORDER BY t.position, t.created_at
          LIMIT ?`,
      )
      .all(...args, q.limit ?? LIST_LIMIT);
  });

  /*
    One task by id. Exists so that opening a task by link — from global
    search, from a mail message, from the dashboard — does not have to
    fetch the family's entire task list and find it client-side, which is
    what forced the list to be unbounded in the first place.

    Tasks carry no owner_id: they belong to the family, not to a person
    (unlike notes and personal accounts), so the tenant and a session are
    the whole guard here.
  */
  app.get('/api/tasks/:id', (req, reply) => {
    const { id: taskId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId);
    if (!row) return reply.code(404).send({ error: 'Task not found' });
    return row;
  });

  app.post('/api/tasks', (req, reply) => {
    const parsed = createInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const d = parsed.data;

    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(d.project_id)) {
      return reply.code(400).send({ error: 'Project not found' });
    }
    if (d.recurrence_rule && !isValidRecurrence(d.recurrence_rule)) {
      return reply.code(400).send({ error: 'Could not parse the recurrence rule' });
    }

    let level = 0;
    if (d.parent_id) {
      const parent = db.prepare('SELECT level, project_id FROM tasks WHERE id = ?').get(d.parent_id) as
        | { level: number; project_id: string }
        | undefined;
      if (!parent) return reply.code(400).send({ error: 'Parent task not found' });
      if (parent.project_id !== d.project_id) {
        return reply.code(400).send({ error: 'Parent task belongs to another project' });
      }
      if (parent.level >= 2) {
        return reply
          .code(400)
          .send({ error: 'Tasks nest at most three levels deep: story, task, subtask' });
      }
      level = parent.level + 1;
    }

    const taskId = id();
    db.prepare(
      `INSERT INTO tasks (id, project_id, parent_id, level, title, description, status, priority,
                          due_date, expected_date, assignee_id, recurrence_rule, position, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT coalesce(max(position), 0) + 1 FROM tasks WHERE project_id = ?), ?)`,
    ).run(
      taskId,
      d.project_id,
      d.parent_id ?? null,
      level,
      d.title.trim(),
      d.description ?? null,
      d.status ?? 'todo',
      d.priority ?? 'normal',
      d.due_date ?? null,
      d.expected_date ?? null,
      d.assignee_id ?? null,
      d.recurrence_rule ?? null,
      d.project_id,
      req.user?.id ?? null,
    );
    return reply.code(201).send(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  });

  app.patch('/api/tasks/:id', (req, reply) => {
    const { id: taskId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = patchInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
    if (!task) return reply.code(404).send({ error: 'Task not found' });

    const d = parsed.data;
    if (d.recurrence_rule && !isValidRecurrence(d.recurrence_rule)) {
      return reply.code(400).send({ error: 'Could not parse the recurrence rule' });
    }

    // A parent change recomputes the level of the whole subtree
    let levelDelta = 0;
    if (d.parent_id !== undefined && d.parent_id !== task.parent_id) {
      let newLevel = 0;
      if (d.parent_id) {
        if (d.parent_id === taskId || isDescendant(d.parent_id, taskId)) {
          return reply.code(400).send({ error: 'A task cannot be nested inside itself' });
        }
        const parent = db.prepare('SELECT level, project_id FROM tasks WHERE id = ?').get(d.parent_id) as
          | { level: number; project_id: string }
          | undefined;
        if (!parent) return reply.code(400).send({ error: 'Parent task not found' });
        if (parent.project_id !== task.project_id) {
          return reply.code(400).send({ error: 'Parent task belongs to another project' });
        }
        newLevel = parent.level + 1;
      }
      if (newLevel + subtreeDepth(taskId) > 2) {
        return reply
          .code(400)
          .send({ error: 'Does not fit: tasks nest at most three levels deep' });
      }
      levelDelta = newLevel - task.level;
    }

    // Same guard as the projects patch: SQL identifiers must come from this
    // literal list, not from request keys — z.object() stripping unknown
    // keys is the only thing protecting the SET clause otherwise. (#63)
    const UPDATABLE = new Set([
      'parent_id',
      'title',
      'description',
      'status',
      'priority',
      'due_date',
      'expected_date',
      'assignee_id',
      'recurrence_rule',
    ]);
    const fields = Object.entries(d).filter(([k, v]) => UPDATABLE.has(k) && v !== undefined);
    const run = db.transaction(() => {
      if (fields.length > 0) {
        const set = fields.map(([k]) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE tasks SET ${set}, updated_at = ? WHERE id = ?`).run(
          ...fields.map(([, v]) => v as string | null),
          now(),
          taskId,
        );
      }
      if (levelDelta !== 0) shiftSubtreeLevels(taskId, levelDelta);

      if (d.status !== undefined) {
        db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(
          d.status === 'done' ? now() : null,
          taskId,
        );
      }
    });
    run();

    // A recurring task spawns the next one when closed
    let spawned: unknown = null;
    if (d.status === 'done' && task.recurrence_rule && task.due_date) {
      // The series starts at the original task — that is what we count from.
      const rootId = task.recurrence_parent_id ?? taskId;
      const root = db.prepare('SELECT due_date FROM tasks WHERE id = ?').get(rootId) as
        | { due_date: string | null }
        | undefined;
      const anchor = root?.due_date ?? task.due_date;
      const next = occurrenceAfter(anchor, task.due_date, task.recurrence_rule);
      if (next) {
        const nextId = id();
        // expected_date is deliberately not copied: it describes how one
        // specific occurrence is going in reality, not the series pattern
        db.prepare(
          `INSERT INTO tasks (id, project_id, parent_id, level, title, description, status,
                              priority, due_date, assignee_id, recurrence_rule,
                              recurrence_parent_id, position, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?,
                   (SELECT coalesce(max(position), 0) + 1 FROM tasks WHERE project_id = ?), ?)`,
        ).run(
          nextId,
          task.project_id,
          task.parent_id,
          task.level,
          task.title,
          task.description,
          task.priority,
          next,
          task.assignee_id,
          task.recurrence_rule,
          task.recurrence_parent_id ?? taskId,
          task.project_id,
          req.user?.id ?? null,
        );
        spawned = db.prepare('SELECT * FROM tasks WHERE id = ?').get(nextId);
      }
    }

    return { task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), spawned };
  });

  /**
   * The order is given as the full list of ids.
   * Simpler and sturdier than computing fractional positions between
   * neighbors: at household volumes rewriting fifty rows costs nothing,
   * and positions never smear apart over time.
   */
  app.post('/api/tasks/reorder', (req, reply) => {
    const parsed = z.object({ ids: z.array(z.string().uuid()).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A list of tasks is expected' });

    const stmt = db.prepare('UPDATE tasks SET position = ? WHERE id = ?');
    const run = db.transaction((ids: string[]) => {
      ids.forEach((taskId, index) => stmt.run(index, taskId));
    });
    run(parsed.data.ids);
    return { ok: true };
  });

  app.delete('/api/tasks/:id', (req, reply) => {
    const { id: taskId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const children = (
      db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_id = ?').get(taskId) as { n: number }
    ).n;

    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Task not found' });
    return { ok: true, deleted_children: children };
  });
}

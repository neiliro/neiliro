import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { runWithDb, id, now } from '../db/index.js';

/*
  The task and note lists are capped (#183).

  Not a style preference: on the hosted service one process serves every
  family, so an endpoint that loads a whole table is a resource one family
  chooses on everyone else's behalf. A family with 50k notes made
  `GET /api/notes` return ~20 MB in 4.5 s and unrelated families waited on
  the shared event loop for it.

  What these tests pin is the pair that has to stay true together: the list
  never returns more than the cap, and opening one object by id never needs
  the list at all — that second half is why capping the first is safe.
*/

const INBOX_PROJECT = '00000000-0000-4000-8000-000000000001';
const LIST_LIMIT = 1000;

let h: Harness;
let alice: { userId: string; cookie: string };

/** Rows straight into the database: the point is volume, not the create route. */
function seedTasks(count: number): void {
  runWithDb(h.db, () => {
    const ins = h.db.prepare(
      `INSERT INTO tasks (id, project_id, level, title, status, priority, position, created_by)
       VALUES (?, ?, 0, ?, 'todo', 'normal', ?, ?)`,
    );
    h.db.transaction(() => {
      for (let i = 0; i < count; i++) ins.run(id(), INBOX_PROJECT, `task ${i}`, i, alice.userId);
    })();
  });
}

function seedNotes(count: number): void {
  runWithDb(h.db, () => {
    const ins = h.db.prepare(
      `INSERT INTO notes (id, title, body_md, owner_id, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'shared', ?, ?)`,
    );
    h.db.transaction(() => {
      for (let i = 0; i < count; i++) {
        ins.run(id(), `note ${i}`, 'x'.repeat(500), alice.userId, now(), now());
      }
    })();
  });
}

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
});

describe('GET /api/tasks is capped', () => {
  it('returns at most the cap even when the family has more', async () => {
    seedTasks(LIST_LIMIT + 250);
    const res = await h.as(alice.cookie, 'GET', '/api/tasks?include_done=true');
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>()).toHaveLength(LIST_LIMIT);
  });

  it('honours a smaller explicit limit', async () => {
    const res = await h.as(alice.cookie, 'GET', '/api/tasks?include_done=true&limit=10');
    expect(res.json<unknown[]>()).toHaveLength(10);
  });

  it('refuses a limit past the maximum rather than obeying it', async () => {
    const res = await h.as(alice.cookie, 'GET', '/api/tasks?limit=999999');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns one task with the same shape the list uses', async () => {
    const created = await h.as(alice.cookie, 'POST', '/api/tasks', {
      project_id: INBOX_PROJECT,
      title: 'open me by link',
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ id: string }>().id;

    const one = await h.as(alice.cookie, 'GET', `/api/tasks/${taskId}`);
    expect(one.statusCode).toBe(200);
    const task = one.json<Record<string, unknown>>();
    expect(task.id).toBe(taskId);
    expect(task.title).toBe('open me by link');
    // The columns the client needs when it opens a task straight from a
    // link, which is the whole reason this route exists
    expect(task).toHaveProperty('project_title');
    expect(task).toHaveProperty('project_id');
    expect(task).toHaveProperty('child_count');
    expect(task).toHaveProperty('child_done');
  });

  it('is reachable past the cap — the list is not a way to find a task', async () => {
    // A task deliberately positioned beyond the capped window
    const late = id();
    runWithDb(h.db, () => {
      h.db
        .prepare(
          `INSERT INTO tasks (id, project_id, level, title, status, priority, position, created_by)
           VALUES (?, ?, 0, 'buried past the cap', 'done', 'normal', 99999, ?)`,
        )
        .run(late, INBOX_PROJECT, alice.userId);
    });

    const list = await h.as(alice.cookie, 'GET', '/api/tasks?include_done=true');
    const ids = list.json<{ id: string }[]>().map((t) => t.id);
    expect(ids).not.toContain(late);

    const one = await h.as(alice.cookie, 'GET', `/api/tasks/${late}`);
    expect(one.statusCode).toBe(200);
    expect(one.json<{ title: string }>().title).toBe('buried past the cap');
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    const missing = await h.as(alice.cookie, 'GET', `/api/tasks/${id()}`);
    expect(missing.statusCode).toBe(404);
    const malformed = await h.as(alice.cookie, 'GET', '/api/tasks/not-a-uuid');
    expect(malformed.statusCode).toBe(400);
  });

  it('needs a session', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/api/tasks/${id()}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/notes is capped', () => {
  it('returns at most the cap even when the family has more', async () => {
    seedNotes(LIST_LIMIT + 120);
    const res = await h.as(alice.cookie, 'GET', '/api/notes');
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>()).toHaveLength(LIST_LIMIT);
  });

  it('honours a smaller explicit limit and refuses an oversized one', async () => {
    expect((await h.as(alice.cookie, 'GET', '/api/notes?limit=5')).json<unknown[]>()).toHaveLength(5);
    expect((await h.as(alice.cookie, 'GET', '/api/notes?limit=999999')).statusCode).toBe(400);
  });

  it('still finds a note by title through search, which the cap must not hide', async () => {
    await h.as(alice.cookie, 'POST', '/api/notes', { title: 'ZZ unique wiki target', content: '' });
    const found = await h.as(
      alice.cookie,
      'GET',
      `/api/notes?q=${encodeURIComponent('ZZ unique wiki target')}`,
    );
    expect(found.json<{ title: string }[]>().map((n) => n.title)).toContain('ZZ unique wiki target');
  });
});

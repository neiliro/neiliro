import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';
import { INBOX_ID } from './projects.js';

/*
  Tasks and projects with encrypted words (ADR 0001, #217). The server
  stores envelopes as given and stops doing the one thing it did with a
  title: copying it into the next occurrence of a recurring task.
*/
let h: Harness;
let alice = { userId: '', cookie: '' };

const enc = (label: string) => `e1:AAAAAAAAAAAAAAAA:${Buffer.from(label).toString('base64url')}`;

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
});

describe('encrypted tasks and projects', () => {
  it('are created under the ids the browser minted and refuse a duplicate', async () => {
    const projectId = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const project = await h.as(alice.cookie, 'POST', '/api/projects', { id: projectId, title: enc('Garden') });
    expect(project.statusCode).toBe(201);
    expect(project.json<{ id: string; title: string }>()).toMatchObject({ id: projectId, title: enc('Garden') });
    expect((await h.as(alice.cookie, 'POST', '/api/projects', { id: projectId, title: enc('Again') })).statusCode).toBe(409);

    const taskId = '8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e';
    const task = await h.as(alice.cookie, 'POST', '/api/tasks', {
      id: taskId,
      project_id: projectId,
      title: enc('Mow'),
      description: enc('The back lawn'),
    });
    expect(task.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/tasks', { id: taskId, project_id: projectId, title: enc('x') })).statusCode).toBe(409);

    // The list joins the project title as stored — an envelope the server never opened
    const rows = (await h.as(alice.cookie, 'GET', `/api/tasks?project_id=${projectId}`)).json<{ id: string; project_title: string }[]>();
    expect(rows.find((r) => r.id === taskId)?.project_title).toBe(enc('Garden'));
  });

  it('closing an encrypted recurring task names the next date instead of copying the title', async () => {
    const created = (
      await h.as(alice.cookie, 'POST', '/api/tasks', {
        project_id: INBOX_ID,
        title: enc('Water plants'),
        due_date: '2026-09-01',
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1',
      })
    ).json<{ id: string }>();

    const closed = await h.as(alice.cookie, 'PATCH', `/api/tasks/${created.id}`, { status: 'done' });
    expect(closed.statusCode).toBe(200);
    const body = closed.json<{ spawned: unknown; next_due: string | null }>();
    expect(body.spawned).toBeNull();
    expect(body.next_due).toBe('2026-09-08');

    // Nothing was inserted: the browser does that, under a fresh id and its own ciphertext
    const all = (await h.as(alice.cookie, 'GET', `/api/tasks?project_id=${INBOX_ID}&include_done=true`)).json<{ id: string; recurrence_parent_id: string | null }[]>();
    expect(all.filter((t) => t.recurrence_parent_id === created.id)).toHaveLength(0);

    // …and it may name the series anchor when it does
    const next = await h.as(alice.cookie, 'POST', '/api/tasks', {
      project_id: INBOX_ID,
      title: enc('Water plants'),
      due_date: body.next_due,
      recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1',
      recurrence_parent_id: created.id,
    });
    expect(next.statusCode).toBe(201);
    expect(next.json<{ recurrence_parent_id: string }>().recurrence_parent_id).toBe(created.id);
  });

  it('still copies a plaintext recurring task on the server, as before the key', async () => {
    const created = (
      await h.as(alice.cookie, 'POST', '/api/tasks', {
        project_id: INBOX_ID,
        title: 'Take out the bins',
        due_date: '2026-09-01',
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=1',
      })
    ).json<{ id: string }>();
    const body = (await h.as(alice.cookie, 'PATCH', `/api/tasks/${created.id}`, { status: 'done' })).json<{
      spawned: { title: string; due_date: string } | null;
      next_due: string | null;
    }>();
    expect(body.next_due).toBeNull();
    expect(body.spawned).toMatchObject({ title: 'Take out the bins', due_date: '2026-09-08' });
  });
});

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';

export const INBOX_ID = '00000000-0000-4000-8000-000000000001';

// Ceilings sized for envelopes (#217): an encrypted value is roughly a third
// longer than its words
const projectInput = z.object({
  title: z.string().min(1, 'Enter a project name').max(4_000),
  description: z.string().max(16_000).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must look like #1F6E8C')
    .optional(),
  icon: z.string().max(16).nullable().optional(),
});

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', (req) => {
    const { archived } = z
      .object({ archived: z.enum(['true', 'false']).optional() })
      .parse(req.query);

    const clause = archived === 'true' ? 'IS NOT NULL' : 'IS NULL';
    return db
      .prepare(
        `SELECT p.*,
                (SELECT count(*) FROM tasks t
                  WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks,
                (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS total_tasks
           FROM projects p
          WHERE p.archived_at ${clause}
          ORDER BY p.position, p.created_at`,
      )
      .all();
  });

  app.post('/api/projects', (req, reply) => {
    // The browser mints the id when it encrypts: the envelope is bound to it
    const parsed = projectInput.extend({ id: z.string().uuid().optional() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const projectId = parsed.data.id ?? id();
    if (parsed.data.id && db.prepare('SELECT 1 FROM projects WHERE id = ?').get(parsed.data.id)) {
      return reply.code(409).send({ error: 'A project with this id already exists' });
    }
    db.prepare(
      `INSERT INTO projects (id, title, description, color, icon, position, created_by)
       VALUES (?, ?, ?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM projects), ?)`,
    ).run(
      projectId,
      parsed.data.title,
      parsed.data.description ?? null,
      parsed.data.color ?? '#2E6F8E',
      parsed.data.icon ?? null,
      req.user?.id ?? null,
    );
    return reply.code(201).send(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
  });

  app.patch('/api/projects/:id', (req, reply) => {
    const { id: projectId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = projectInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }

    // The SET clause is built from these keys, so they must never be
    // request-derived. Today z.object() strips unknown keys, but that is a
    // silent, load-bearing default — one .passthrough() added to the schema
    // for an unrelated reason would turn request JSON into SQL identifiers.
    // The literal list makes the dependency explicit. (#63)
    const UPDATABLE = new Set(['title', 'description', 'color', 'icon']);
    const fields = Object.entries(parsed.data).filter(
      ([k, v]) => UPDATABLE.has(k) && v !== undefined,
    );
    if (fields.length === 0) return reply.code(400).send({ error: 'Nothing to change' });

    const set = fields.map(([k]) => `${k} = ?`).join(', ');
    const result = db
      .prepare(`UPDATE projects SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...fields.map(([, v]) => v as string | null), now(), projectId);

    if (result.changes === 0) return reply.code(404).send({ error: 'Project not found' });
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  });

  app.post('/api/projects/:id/archive', (req, reply) => {
    const { id: projectId } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (projectId === INBOX_ID) {
      return reply.code(400).send({ error: 'Inbox cannot be archived' });
    }

    const project = db.prepare('SELECT archived_at FROM projects WHERE id = ?').get(projectId) as
      | { archived_at: string | null }
      | undefined;
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    const archived = project.archived_at ? null : now();
    db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').run(
      archived,
      now(),
      projectId,
    );
    return { archived: Boolean(archived) };
  });

  app.delete('/api/projects/:id', (req, reply) => {
    const { id: projectId } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (projectId === INBOX_ID) {
      return reply.code(400).send({ error: 'Inbox cannot be deleted' });
    }

    const open = (
      db
        .prepare(`SELECT count(*) AS n FROM tasks WHERE project_id = ?`)
        .get(projectId) as { n: number }
    ).n;
    if (open > 0) {
      return reply.code(409).send({
        error:
          `The project has ${open} ${open === 1 ? 'task' : 'tasks'}. ` +
          'Deleting the project deletes them too — archive the project or move the tasks first',
      });
    }

    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Project not found' });
    return { ok: true };
  });

  /** Who tasks can be assigned to. Available to everyone; not an admin section. */
  app.get('/api/household', () =>
    db
      .prepare(
        `SELECT id, name, color FROM users
          WHERE disabled_at IS NULL AND role IN ('member','admin')
          ORDER BY name`,
      )
      .all(),
  );
}

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, id, now } from '../db/index.js';
import { env } from '../env.js';

/*
  Shared lists (#11) — the shopping list and its friends.

  Everything here is shaped by one requirement: it has to feel instant on a
  phone. So the write endpoints are as small as they can be — an add takes
  a title and nothing else, a check is a toggle with no body — and the read
  endpoint returns the whole list in one go, because a list is small and a
  second round-trip costs more than the rows do.

  Lists are shared, with no per-person visibility. See migration 025: for
  this feature privacy would defeat the purpose.
*/

export const SHOPPING_LIST_ID = '00000000-0000-4000-8000-000000000301';

const titleInput = z.object({ title: z.string().trim().min(1, 'Enter a name').max(200) });

export async function registerListRoutes(app: FastifyInstance): Promise<void> {
  /** Every list with its open count — enough to render the sidebar badge. */
  app.get('/api/lists', () => {
    return db
      .prepare(
        `SELECT l.*,
                (SELECT count(*) FROM list_items i
                  WHERE i.list_id = l.id AND i.checked_at IS NULL) AS open_items,
                (SELECT count(*) FROM list_items i
                  WHERE i.list_id = l.id AND i.checked_at IS NOT NULL) AS checked_items
           FROM lists l
          ORDER BY l.position, l.created_at`,
      )
      .all();
  });

  app.post('/api/lists', (req, reply) => {
    const parsed = titleInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const listId = id();
    db.prepare(
      `INSERT INTO lists (id, title, position, created_by, created_at)
       VALUES (?, ?, (SELECT coalesce(max(position), 0) + 1 FROM lists), ?, ?)`,
    ).run(listId, parsed.data.title, req.user!.id, now());
    return reply.code(201).send(db.prepare('SELECT * FROM lists WHERE id = ?').get(listId));
  });

  app.get('/api/lists/:id', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
    if (!list) return reply.code(404).send({ error: 'List not found' });

    /*
      Unchecked first in their own order, then the checked pile newest
      first. That ordering is the whole "auto-clear" behaviour: the list
      reads as clean without anything being deleted behind the family's
      back, and what was just bought is still visible for the walk home.
    */
    const items = db
      .prepare(
        `SELECT * FROM list_items
          WHERE list_id = ?
          ORDER BY checked_at IS NOT NULL, CASE WHEN checked_at IS NULL THEN position END,
                   checked_at DESC`,
      )
      .all(listId);
    return { ...list, items };
  });

  app.patch('/api/lists/:id', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = titleInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const result = db
      .prepare('UPDATE lists SET title = ? WHERE id = ?')
      .run(parsed.data.title, listId);
    if (result.changes === 0) return reply.code(404).send({ error: 'List not found' });
    return db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  });

  app.delete('/api/lists/:id', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = db.prepare('DELETE FROM lists WHERE id = ?').run(listId);
    if (result.changes === 0) return reply.code(404).send({ error: 'List not found' });
    return { ok: true };
  });

  /** One tap: add an item. Position goes to the end — a list reads in the order it was written. */
  app.post('/api/lists/:id/items', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const parsed = titleInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Check the fields' });
    }
    const exists = db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId);
    if (!exists) return reply.code(404).send({ error: 'List not found' });

    // Duplicates are allowed on purpose: "milk" twice means two bottles,
    // and a dedupe check would be a surprise mid-shop.
    const itemId = id();
    db.prepare(
      `INSERT INTO list_items (id, list_id, title, position, created_by, created_at)
       VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM list_items WHERE list_id = ?), ?, ?)`,
    ).run(itemId, listId, parsed.data.title, listId, req.user!.id, now());
    return reply.code(201).send(db.prepare('SELECT * FROM list_items WHERE id = ?').get(itemId));
  });

  /** One tap: check or uncheck. Idempotent per state, so a double-tap in a shop is harmless. */
  app.post('/api/list-items/:id/toggle', (req, reply) => {
    const { id: itemId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const item = db.prepare('SELECT id, checked_at FROM list_items WHERE id = ?').get(itemId) as
      | { id: string; checked_at: string | null }
      | undefined;
    if (!item) return reply.code(404).send({ error: 'Item not found' });

    db.prepare('UPDATE list_items SET checked_at = ? WHERE id = ?').run(
      item.checked_at ? null : now(),
      itemId,
    );
    return db.prepare('SELECT * FROM list_items WHERE id = ?').get(itemId);
  });

  app.delete('/api/list-items/:id', (req, reply) => {
    const { id: itemId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = db.prepare('DELETE FROM list_items WHERE id = ?').run(itemId);
    if (result.changes === 0) return reply.code(404).send({ error: 'Item not found' });
    return { ok: true };
  });

  /** Clear the checked pile — one action instead of deleting items one by one. */
  app.post('/api/lists/:id/clear-checked', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const exists = db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId);
    if (!exists) return reply.code(404).send({ error: 'List not found' });

    const result = db
      .prepare('DELETE FROM list_items WHERE list_id = ? AND checked_at IS NOT NULL')
      .run(listId);
    return { cleared: result.changes };
  });

  // ── The public link ───────────────────────────────────────────────────

  const shareRate = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.post('/api/lists/:id/share', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    // A public sandbox must not mint public URLs into the real world
    if (env.demoMode) return reply.code(403).send({ error: 'Disabled in the demo' });

    const list = db.prepare('SELECT id, share_token FROM lists WHERE id = ?').get(listId) as
      | { id: string; share_token: string | null }
      | undefined;
    if (!list) return reply.code(404).send({ error: 'List not found' });

    // Asking twice hands back the same link, so it can be re-sent
    if (list.share_token) return { path: `/list/${list.share_token}` };

    const token = randomBytes(24).toString('base64url');
    db.prepare('UPDATE lists SET share_token = ? WHERE id = ?').run(token, listId);
    return reply.code(201).send({ path: `/list/${token}` });
  });

  app.delete('/api/lists/:id/share', (req, reply) => {
    const { id: listId } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = db.prepare('UPDATE lists SET share_token = NULL WHERE id = ?').run(listId);
    if (result.changes === 0) return reply.code(404).send({ error: 'List not found' });
    return { ok: true };
  });

  const TOKEN = z.object({ token: z.string().min(10).max(200) });

  const listByToken = (token: string) =>
    db.prepare('SELECT id, title FROM lists WHERE share_token = ?').get(token) as
      | { id: string; title: string }
      | undefined;

  /*
    The guest view: this list and nothing else. No other lists, no family
    names, nothing about who added what — a list handed to a neighbour
    must not come with the household attached.
  */
  app.get('/api/list/:token', shareRate, (req, reply) => {
    const { token } = TOKEN.parse(req.params);
    const list = listByToken(token);
    if (!list) return reply.code(404).send({ error: 'This link is no longer valid' });

    const items = db
      .prepare(
        `SELECT id, title, checked_at FROM list_items
          WHERE list_id = ?
          ORDER BY checked_at IS NOT NULL, CASE WHEN checked_at IS NULL THEN position END,
                   checked_at DESC`,
      )
      .all(list.id);
    return { id: list.id, title: list.title, items };
  });

  /*
    The one thing a guest may change. Sending someone a shopping list is
    pointless if they cannot tick things off, so this is deliberately a
    write — and deliberately the only one: no adding, no renaming, no
    deleting, and the item must belong to the shared list.
  */
  app.post('/api/list/:token/items/:itemId/toggle', shareRate, (req, reply) => {
    const { token } = TOKEN.parse(req.params);
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(req.params);
    const list = listByToken(token);
    if (!list) return reply.code(404).send({ error: 'This link is no longer valid' });

    const item = db
      .prepare('SELECT id, checked_at FROM list_items WHERE id = ? AND list_id = ?')
      .get(itemId, list.id) as { id: string; checked_at: string | null } | undefined;
    // An item from another list is simply not found here — the token scopes
    // the write as tightly as it scopes the read
    if (!item) return reply.code(404).send({ error: 'Item not found' });

    db.prepare('UPDATE list_items SET checked_at = ? WHERE id = ?').run(
      item.checked_at ? null : now(),
      itemId,
    );
    return db.prepare('SELECT id, title, checked_at FROM list_items WHERE id = ?').get(itemId);
  });
}

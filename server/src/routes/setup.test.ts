import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-harness.js';
import { USER_COLORS } from './setup.js';

/*
  Issue #48: the admin created by POST /api/auth/setup used to skip the
  color column, so the row took the schema default (#2E6F8E) — a
  near-twin of USER_COLORS[0] (#1F6E8C), the color the very first
  invited member gets. A two-person household ended up with matching
  avatars. The fix binds nextColor() on the admin insert too, so the
  admin should land on a real palette entry, not the schema default.

  Called directly through app.inject rather than the join() harness
  helper: join() exists for guard tests and inserts a user without going
  through the setup route at all, which is exactly the code path under
  test here. The harness's database starts empty, so this is the one
  request that is allowed to hit /api/auth/setup and succeed.
*/
describe('POST /api/auth/setup', () => {
  it('gives the admin a real palette color, not the schema default', async () => {
    const hub = await buildTestApp();

    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        name: 'Alex',
        email: 'alex@hub.local',
        password: 'correct horse battery staple',
      },
    });
    expect(res.statusCode).toBe(201);

    const row = hub.db.prepare('SELECT color FROM users').get() as { color: string };
    expect(row.color).not.toBe('#2E6F8E');
    expect(USER_COLORS).toContain(row.color);
    expect(row.color).toBe(USER_COLORS[0]);
  });

  it('asks for no consent on a self-hosted hub and records none, even if sent', async () => {
    // No contract with the service: the checkbox is not shown, the field
    // is ignored, the column stays NULL (migration 031).
    const hub = await buildTestApp();
    const state = await hub.app.inject({ url: '/api/auth/state' });
    expect(state.json()).toMatchObject({ hosted: false, apex: null });

    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        name: 'Alex',
        email: 'alex@hub.local',
        password: 'correct horse battery staple',
        accept_terms: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const row = hub.db.prepare('SELECT terms_accepted_at FROM users').get() as {
      terms_accepted_at: string | null;
    };
    expect(row.terms_accepted_at).toBeNull();
  });
});

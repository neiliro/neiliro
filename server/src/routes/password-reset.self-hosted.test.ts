import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-harness.js';

/*
  The reset-by-email flow must not exist on a self-hosted hub.

  Not "must refuse" — must not be there at all. The family that runs the
  machine already has a stronger recovery door: ssh plus
  scripts/admin-reset.mjs, which needs no mail provider and cannot be
  reached from the internet. Shipping an email flow next to it would add
  attack surface to replace a better door, and would quietly require every
  self-hoster to run a mail service to make their login screen honest.

  This file carries no hosted flags on purpose: it is the default install.
*/

describe('password reset on a self-hosted hub', () => {
  it('is not registered at all', async () => {
    const { app } = await buildTestApp();

    for (const url of ['/api/auth/password-reset', '/api/auth/password-reset/confirm']) {
      const res = await app.inject({ method: 'POST', url, payload: { email: 'sam@example.test' } });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('does not offer the link on the sign-in screen', async () => {
    const { app } = await buildTestApp();
    const state = await app.inject({ url: '/api/auth/state' });
    // The frontend hides "forgot password?" on this flag, so a hub that
    // cannot send must not claim it can
    expect(state.json()).toMatchObject({ password_reset: false });
  });
});

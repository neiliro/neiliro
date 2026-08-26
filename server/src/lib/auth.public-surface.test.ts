import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-harness.js';

/*
  The list of routes reachable without a session, pinned.

  Every entry in PUBLIC_PATHS is a door in the wall, and the wall is the
  reason a stranger on the internet cannot read a family's notes. Adding a
  door is sometimes right — sign-in, invites, the mail webhook all had to
  be public — but it must never happen as a side effect of something else.
  So the surface is a snapshot: widening it fails here, and the PR has to
  say why in its diff.

  Two claims are checked, because the list alone proves neither: that the
  source still contains exactly these paths, and that the wall around them
  is actually standing.
*/

const AUTH_TS = join(dirname(fileURLToPath(import.meta.url)), 'auth.ts');

const PUBLIC_SNAPSHOT = [
  '/api/auth/demo',
  '/api/auth/email-verify',
  '/api/auth/google/callback',
  '/api/auth/google/finish',
  '/api/auth/google/start',
  '/api/auth/invite',
  '/api/auth/join',
  '/api/auth/login',
  '/api/auth/mfa',
  '/api/auth/password-reset',
  '/api/auth/password-reset/confirm',
  '/api/auth/setup',
  '/api/auth/state',
  '/api/health',
  '/api/home-name',
  // Signature-authenticated, not session-authenticated: Mailgun is not a
  // browser (routes/mail-inbound.ts refuses anything unsigned).
  '/api/mail/inbound/mime',
];

describe('public API surface', () => {
  const source = readFileSync(AUTH_TS, 'utf8');

  it('is exactly the pinned list', () => {
    const block = source.slice(
      source.indexOf('const PUBLIC_PATHS'),
      source.indexOf('export async function authenticate'),
    );
    const paths = [...block.matchAll(/'(\/api\/[^']+)'/g)].map((m) => m[1]!).sort();
    expect(paths).toEqual([...PUBLIC_SNAPSHOT].sort());
  });

  it('exempts only the token-addressed subtrees', () => {
    /*
      A prefix exemption is broader than a path and deserves louder review.
      Both entries here are the same shape: an unguessable token in the
      path, read-only, addressing one person's data — the public wishlist
      and the calendar subscription feed. Anything else appearing in this
      list is a subtree opened to the internet, which is the point of
      failing here.
    */
    const fn = source.slice(source.indexOf('export async function authenticate'));
    const prefixes = [...fn.matchAll(/startsWith\('(\/api[^']*)'\)/g)].map((m) => m[1]!);
    expect(prefixes.filter((p) => p !== '/api').sort()).toEqual([
      '/api/calendar/feed/',
      '/api/wishlist/',
    ]);
  });

  it('still refuses an anonymous request to a route outside the list', async () => {
    // The snapshot would be worthless if the check it describes stopped
    // running — assert the wall, not only the door list.
    const { app } = await buildTestApp();
    for (const url of ['/api/mail', '/api/notes', '/api/money/accounts', '/api/settings']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

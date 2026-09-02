import { describe, expect, it } from 'vitest';
import { redactUrl } from './app.js';

/*
  redactUrl is a security seam: it decides what secrets reach the log.
  Query values were always masked (invite tokens); the wishlist share
  token travels in the PATH, and before this test existed a rate-limited
  guest request wrote the live link into the log at warn level.
*/
describe('redactUrl', () => {
  it('masks the wishlist token path segment', () => {
    expect(redactUrl('/api/wishlist/AbC123xyz-_456')).toBe('/api/wishlist/…');
    expect(redactUrl('/api/wishlist/AbC123xyz/claim')).toBe('/api/wishlist/…/claim');
  });

  it('masks every token-addressed surface, not only the first one built (#186)', () => {
    // Three surfaces were added after the wishlist and each logged its
    // live token on a 404 or a 429, because the mask named one prefix.
    expect(redactUrl('/api/calendar/feed/FeedTok3n_-abc')).toBe('/api/calendar/feed/…');
    expect(redactUrl('/api/event/Ev3ntTok3n')).toBe('/api/event/…');
    expect(redactUrl('/api/event/Ev3ntTok3n/ics')).toBe('/api/event/…/ics');
    expect(redactUrl('/api/list/L1stTok3n')).toBe('/api/list/…');
    // The item id after the token is a plain uuid, not a secret — it stays
    expect(redactUrl('/api/list/L1stTok3n/items/0b6d1c2e-1111-4222-8333-444455556666/toggle')).toBe(
      '/api/list/…/items/0b6d1c2e-1111-4222-8333-444455556666/toggle',
    );
    // A token with a query string behind it: both halves masked
    expect(redactUrl('/api/event/Ev3ntTok3n?lang=ru')).toBe('/api/event/…?lang=…');
  });

  it('does not touch the authenticated siblings that share a prefix root', () => {
    // /api/calendar/feed (no trailing segment) creates and revokes the
    // token behind auth; /api/lists (plural) and /api/events are the
    // ordinary authenticated routes. None of them carries a token.
    expect(redactUrl('/api/calendar/feed')).toBe('/api/calendar/feed');
    expect(redactUrl('/api/lists/0b6d1c2e-1111-4222-8333-444455556666')).toBe(
      '/api/lists/0b6d1c2e-1111-4222-8333-444455556666',
    );
    expect(redactUrl('/api/events?from=2026-09-01')).toBe('/api/events?from=…');
  });

  it('still masks query values and leaves plain paths alone', () => {
    expect(redactUrl('/api/auth/invite?token=SECRET')).toBe('/api/auth/invite?token=…');
    expect(redactUrl('/api/tasks')).toBe('/api/tasks');
  });
});

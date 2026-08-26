import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  The subscribe-by-URL calendar feed.

  It is the second thing in this hub reachable without a session, so the
  interesting tests are not "does it produce ICS" (lib/ics.test.ts covers
  the format) but who can see what through it: the token addresses one
  person's view, and a private calendar belonging to someone else must not
  leak into it. A leak here would be silent — the feed lives in a phone,
  where nobody reads it as a security surface.
*/

let h: Harness;
let alice: { userId: string; cookie: string };
let bob: { userId: string; cookie: string };

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  bob = h.join('Bob');
});

async function tokenFor(cookie: string): Promise<string> {
  const res = await h.as(cookie, 'POST', '/api/calendar/feed', {});
  expect(res.statusCode).toBe(200);
  return res.json<{ token: string }>().token;
}

/** The feed as an anonymous client — a calendar app has no session. */
async function feed(token: string) {
  return h.app.inject({ url: `/api/calendar/feed/${token}` });
}

async function makeCalendar(cookie: string, name: string, shared: boolean) {
  const res = await h.as(cookie, 'POST', '/api/calendars', { name, shared });
  expect(res.statusCode).toBeLessThan(300);
  return res.json<{ id: string }>().id;
}

async function makeEvent(cookie: string, calendarId: string, title: string) {
  const res = await h.as(cookie, 'POST', '/api/events', {
    calendar_id: calendarId,
    title,
    starts_at: '2026-08-20T09:00',
    ends_at: '2026-08-20T09:30',
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json<{ id: string }>().id;
}

describe('calendar feed', () => {
  it('serves ICS to a client with no session', async () => {
    const shared = await makeCalendar(alice.cookie, 'Family things', true);
    await makeEvent(alice.cookie, shared, 'Dentist');

    const res = await feed(await tokenFor(alice.cookie));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.body).toContain('BEGIN:VCALENDAR');
    expect(res.body).toContain('SUMMARY:Dentist');
  });

  it('accepts the .ics suffix calendar apps like to append', async () => {
    const token = await tokenFor(alice.cookie);
    const res = await h.app.inject({ url: `/api/calendar/feed/${token}.ics` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('BEGIN:VCALENDAR');
  });

  it("never leaks another person's private calendar", async () => {
    const secret = await makeCalendar(bob.cookie, "Bob's therapy", false);
    await makeEvent(bob.cookie, secret, 'Appointment');

    // Alice's feed is Alice's view: shared calendars plus her own private ones
    const res = await feed(await tokenFor(alice.cookie));
    expect(res.body).toContain('SUMMARY:Dentist');
    expect(res.body).not.toContain('Appointment');

    // And Bob's own feed does show it — the filter is per viewer, not a blanket hide
    const bobFeed = await feed(await tokenFor(bob.cookie));
    expect(bobFeed.body).toContain('SUMMARY:Appointment');
  });

  it('hands back the same token when asked twice, so the link can be re-shown', async () => {
    const first = await tokenFor(alice.cookie);
    const second = await tokenFor(alice.cookie);
    expect(second).toBe(first);

    const shown = await h.as(alice.cookie, 'GET', '/api/calendar/feed');
    expect(shown.json<{ token: string | null }>().token).toBe(first);
  });

  it('stops serving once revoked', async () => {
    const token = await tokenFor(alice.cookie);
    expect((await feed(token)).statusCode).toBe(200);

    expect((await h.as(alice.cookie, 'DELETE', '/api/calendar/feed')).statusCode).toBe(200);
    // Every subscribed device goes dark, which is the whole safety story
    expect((await feed(token)).statusCode).toBe(404);
    expect(
      (await h.as(alice.cookie, 'GET', '/api/calendar/feed')).json<{ token: string | null }>().token,
    ).toBeNull();
  });

  it('answers an unknown token with 404, not 401', async () => {
    // There is nothing to sign in to, and a missing unguessable URL should
    // look like any other missing page
    expect((await feed('definitely-not-a-real-token')).statusCode).toBe(404);
  });
});

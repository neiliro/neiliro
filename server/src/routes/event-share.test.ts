import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  The public link for one event.

  The risk here is not access — the token is unguessable — but *scope*: a
  link meant to say "the party is on Saturday at three" must not become a
  window into the household. So the tests are mostly about what the public
  response does NOT contain, which is the part that would leak quietly.
*/

let h: Harness;
let alice: { userId: string; cookie: string };
let bob: { userId: string; cookie: string };

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  bob = h.join('Bob');
});

async function calendar(cookie: string, name: string, shared: boolean) {
  const res = await h.as(cookie, 'POST', '/api/calendars', { name, shared });
  return res.json<{ id: string }>().id;
}

async function event(cookie: string, calendarId: string, over: Record<string, unknown> = {}) {
  const res = await h.as(cookie, 'POST', '/api/events', {
    calendar_id: calendarId,
    title: 'Birthday party',
    location: '14 Oak Street',
    description: 'Bring nothing, just come',
    starts_at: '2026-09-05T15:00',
    ends_at: '2026-09-05T18:00',
    ...over,
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json<{ id: string }>().id;
}

async function share(cookie: string, eventId: string) {
  const res = await h.as(cookie, 'POST', `/api/events/${eventId}/share`, {});
  return { statusCode: res.statusCode, path: res.json<{ path?: string }>().path };
}

const tokenOf = (path: string) => path.replace('/event/', '');

describe('sharing one event by link', () => {
  it('serves what, when and where to a stranger with no session', async () => {
    const cal = await calendar(alice.cookie, 'Family things', true);
    const id = await event(alice.cookie, cal);
    const { statusCode, path } = await share(alice.cookie, id);
    expect(statusCode).toBe(201);

    const res = await h.app.inject({ url: `/api/event/${tokenOf(path!)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.title).toBe('Birthday party');
    expect(body.location).toBe('14 Oak Street');
    expect(body.starts_at).toBe('2026-09-05T15:00');
  });

  it('reveals the event and nothing around it', async () => {
    const cal = await calendar(alice.cookie, 'Family things', true);
    const id = await event(alice.cookie, cal, { title: 'Sports day' });
    const { path } = await share(alice.cookie, id);

    const body = (await h.app.inject({ url: `/api/event/${tokenOf(path!)}` })).json<
      Record<string, unknown>
    >();
    // The calendar's own name can be private ("Bob's therapy"), and who is
    // attending is nobody else's business
    for (const leaked of ['calendar_id', 'calendar_name', 'calendar_color', 'participants', 'project_id']) {
      expect(body, leaked).not.toHaveProperty(leaked);
    }
  });

  it('refuses to share an event the asker cannot see', async () => {
    const secret = await calendar(bob.cookie, "Bob's therapy", false);
    const id = await event(bob.cookie, secret, { title: 'Appointment' });

    const res = await h.as(alice.cookie, 'POST', `/api/events/${id}/share`, {});
    // 404, not 403: a private event must not confirm it exists
    expect(res.statusCode).toBe(404);
  });

  it('hands back the same link when asked twice', async () => {
    const cal = await calendar(alice.cookie, 'Family things', true);
    const id = await event(alice.cookie, cal, { title: 'Recital' });
    const first = await share(alice.cookie, id);
    const second = await share(alice.cookie, id);
    expect(second.path).toBe(first.path);
    // Created once, then simply returned
    expect(second.statusCode).toBe(200);
  });

  it('stops working when revoked', async () => {
    const cal = await calendar(alice.cookie, 'Family things', true);
    const id = await event(alice.cookie, cal, { title: 'Cancelled thing' });
    const { path } = await share(alice.cookie, id);
    const token = tokenOf(path!);

    expect((await h.app.inject({ url: `/api/event/${token}` })).statusCode).toBe(200);
    expect((await h.as(alice.cookie, 'DELETE', `/api/events/${id}/share`)).statusCode).toBe(200);
    expect((await h.app.inject({ url: `/api/event/${token}` })).statusCode).toBe(404);
  });

  it('offers the event as a file, so a stranger can add it to their calendar', async () => {
    const cal = await calendar(alice.cookie, 'Family things', true);
    const id = await event(alice.cookie, cal, { title: 'School fair' });
    const { path } = await share(alice.cookie, id);

    const res = await h.app.inject({ url: `/api/event/${tokenOf(path!)}/ics` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['content-disposition']).toContain('event.ics');
    expect(res.body).toContain('BEGIN:VEVENT');
    expect(res.body).toContain('SUMMARY:School fair');
    // Floating local time here too: 15:00 stays 15:00 for the reader
    expect(res.body).toContain('DTSTART:20260905T150000');
  });

  it('answers an unknown token with 404', async () => {
    expect((await h.app.inject({ url: '/api/event/nope-not-a-token' })).statusCode).toBe(404);
  });
});

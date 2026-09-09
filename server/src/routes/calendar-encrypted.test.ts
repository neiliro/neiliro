import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  Events with encrypted words (ADR 0001, #218), and the one place the
  server opens an envelope: a feed or a shared-event link whose token
  carries the family key. The envelopes here are real — the same AES-GCM
  construction the browser uses — because the point under test is that the
  server's opener and the browser's sealer agree.
*/
let h: Harness;
let alice = { userId: '', cookie: '' };

const rawKey = webcrypto.getRandomValues(new Uint8Array(32));
const keyB64 = Buffer.from(rawKey).toString('base64url');
let key: webcrypto.CryptoKey;

async function seal(table: string, column: string, id: string, text: string): Promise<string> {
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: Buffer.from(`${table}/${column}/${id}`) },
    key,
    Buffer.from(text, 'utf8'),
  );
  return `e1:${Buffer.from(nonce).toString('base64url')}:${Buffer.from(ct).toString('base64url')}`;
}

const SHARED_CALENDAR = '00000000-0000-4000-8000-000000000201';

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
  key = await webcrypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
});

describe('encrypted events', () => {
  const eventId = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

  it('are stored as given under the id the browser minted', async () => {
    const created = await h.as(alice.cookie, 'POST', '/api/events', {
      id: eventId,
      calendar_id: SHARED_CALENDAR,
      title: await seal('events', 'title', eventId, 'Dentist'),
      location: await seal('events', 'location', eventId, 'Main street 3'),
      starts_at: '2026-09-20T09:00',
      ends_at: '2026-09-20T09:30',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ id: string; title: string }>().id).toBe(eventId);
    expect(created.json<{ title: string }>().title.startsWith('e1:')).toBe(true);
    expect((await h.as(alice.cookie, 'POST', '/api/events', { id: eventId, calendar_id: SHARED_CALENDAR, title: 'x', starts_at: '2026-09-20', ends_at: '2026-09-20' })).statusCode).toBe(409);

    // The occurrence carries the ciphertext, and its id still names the event
    const window = (await h.as(alice.cookie, 'GET', '/api/events?from=2026-09-01&to=2026-09-30')).json<{ event_id: string; title: string }[]>();
    expect(window.find((o) => o.event_id === eventId)?.title.startsWith('e1:')).toBe(true);
  });

  it('are opened in the feed only when the link carries the key', async () => {
    const token = (await h.as(alice.cookie, 'POST', '/api/calendar/feed', {})).json<{ token: string }>().token;

    const withKey = await h.app.inject({ url: `/api/calendar/feed/${token}~${keyB64}.ics` });
    expect(withKey.statusCode).toBe(200);
    expect(withKey.body).toContain('SUMMARY:Dentist');
    expect(withKey.body).toContain('LOCATION:Main street 3');

    // A link from before the key — or one shown on a locked device — opens nothing
    const without = await h.app.inject({ url: `/api/calendar/feed/${token}.ics` });
    expect(without.statusCode).toBe(200);
    expect(without.body).not.toContain('Dentist');
    expect(without.body).toContain('SUMMARY:••••••');

    // A wrong key reads as the placeholder too, never as an error page
    const wrong = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const bad = await h.app.inject({ url: `/api/calendar/feed/${token}~${wrong}` });
    expect(bad.statusCode).toBe(200);
    expect(bad.body).toContain('SUMMARY:••••••');
  });

  it('open for a guest whose event link carries the key', async () => {
    const share = await h.as(alice.cookie, 'POST', `/api/events/${eventId}/share`, {});
    const path = share.json<{ path: string }>().path;

    const guest = await h.app.inject({ url: `/api${path}~${keyB64}` });
    expect(guest.statusCode).toBe(200);
    expect(guest.json<{ title: string; location: string }>()).toMatchObject({ title: 'Dentist', location: 'Main street 3' });

    const ics = await h.app.inject({ url: `/api${path}~${keyB64}/ics` });
    expect(ics.body).toContain('SUMMARY:Dentist');

    const bare = await h.app.inject({ url: `/api${path}` });
    expect(bare.json<{ title: string }>().title).toBe('••••••');
  });

  it('leave plaintext events from before the key readable everywhere', async () => {
    await h.as(alice.cookie, 'POST', '/api/events', {
      calendar_id: SHARED_CALENDAR,
      title: 'Old picnic',
      starts_at: '2026-09-21',
      ends_at: '2026-09-21',
    });
    const token = (await h.as(alice.cookie, 'POST', '/api/calendar/feed', {})).json<{ token: string }>().token;
    const res = await h.app.inject({ url: `/api/calendar/feed/${token}` });
    expect(res.body).toContain('SUMMARY:Old picnic');
  });
});

describe('encrypted calendars', () => {
  it('accept the browser-minted id and stop ordering by name', async () => {
    const calendarId = '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c';
    const created = await h.as(alice.cookie, 'POST', '/api/calendars', {
      id: calendarId,
      name: await seal('calendars', 'name', calendarId, 'School'),
    });
    expect(created.statusCode).toBe(201);
    expect((await h.as(alice.cookie, 'POST', '/api/calendars', { id: calendarId, name: 'x' })).statusCode).toBe(409);
    const list = (await h.as(alice.cookie, 'GET', '/api/calendars')).json<{ id: string; name: string }[]>();
    expect(list.find((c) => c.id === calendarId)?.name.startsWith('e1:')).toBe(true);
  });
});

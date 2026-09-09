import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  Files under the family key (ADR 0001, #222). The server's part: accept a
  `sealed:<id>` part as bytes it cannot read, serve them back as an opaque
  download with the envelope kind in a header, and let the one-time job
  replace a plaintext file in place without changing its id.
*/
let h: Harness;
let alice = { userId: '', cookie: '' };

const enc = (label: string) => `e1:AAAAAAAAAAAAAAAA:${Buffer.from(label).toString('base64url')}`;

/** A multipart body by hand: one part, named and typed as the browser would. */
function multipart(field: string, filename: string, mime: string, content: Buffer) {
  const boundary = 'neiliro-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  h = await buildTestApp();
  alice = h.join('Alice');
});

/** A GET with the response headers, which the harness's `as` does not expose. */
const get = (url: string) => h.app.inject({ url, headers: { cookie: `hub_session=${alice.cookie}` } });

async function makeNote(): Promise<string> {
  return (await h.as(alice.cookie, 'POST', '/api/notes', { title: 'With files' })).json<{ id: string }>().id;
}

describe('a sealed upload', () => {
  const fileId = 'f1e2d3c4-b5a6-4978-8a1b-2c3d4e5f6a7b';
  const sealedBytes = Buffer.from('NE1 not really ciphertext but the server cannot tell');

  it('is stored under the id the browser minted, filename included, and served opaque', async () => {
    const noteId = await makeNote();
    const body = multipart(`sealed:${fileId}`, enc('receipt.jpg'), 'image/jpeg', sealedBytes);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/notes/${noteId}/attachments`,
      headers: { ...body.headers, cookie: `hub_session=${alice.cookie}` },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    const { uploaded } = res.json<{ uploaded: { id: string; filename: string; encryption: number; is_image: boolean; mime: string }[] }>();
    expect(uploaded[0]).toMatchObject({ id: fileId, filename: enc('receipt.jpg'), encryption: 1, is_image: true, mime: 'image/jpeg' });

    // The same id again is refused, not overwritten
    const again = await h.app.inject({
      method: 'POST',
      url: `/api/notes/${noteId}/attachments`,
      headers: { ...body.headers, cookie: `hub_session=${alice.cookie}` },
      payload: body.payload,
    });
    expect(again.statusCode).toBe(409);

    // Served as bytes, not as an image: the browser opens it after the fetch
    const got = await get(`/api/attachments/${fileId}`);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toContain('application/octet-stream');
    expect(got.headers['x-neiliro-encryption']).toBe('1');
    expect(got.headers['content-disposition']).toContain(`${fileId}.ne1`);
    expect(got.rawPayload.equals(sealedBytes)).toBe(true);

    // The note lists the kind, so the client knows which files to open
    const note = (await h.as(alice.cookie, 'GET', `/api/notes/${noteId}`)).json<{ attachments: { id: string; encryption: number }[] }>();
    expect(note.attachments.find((a) => a.id === fileId)?.encryption).toBe(1);
  });

  it('a plaintext file is still served as before, and can be replaced in place by the job', async () => {
    const noteId = await makeNote();
    const plain = multipart('file', 'notes.txt', 'text/plain', Buffer.from('hello'));
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/notes/${noteId}/attachments`,
      headers: { ...plain.headers, cookie: `hub_session=${alice.cookie}` },
      payload: plain.payload,
    });
    const { uploaded } = res.json<{ uploaded: { id: string; encryption: number }[] }>();
    const id = uploaded[0]!.id;
    expect(uploaded[0]!.encryption).toBe(0);

    const before = await get(`/api/attachments/${id}`);
    expect(before.headers['content-type']).toContain('text/plain');
    expect(before.headers['x-neiliro-encryption']).toBeUndefined();
    expect(before.body).toBe('hello');

    const sealed = multipart(`sealed:${id}`, enc('notes.txt'), 'text/plain', Buffer.from('NE1 sealed bytes'));
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/attachments/${id}`,
      headers: { ...sealed.headers, cookie: `hub_session=${alice.cookie}` },
      payload: sealed.payload,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<{ encryption: number; filename: string }>()).toMatchObject({ encryption: 1, filename: enc('notes.txt') });

    const after = await get(`/api/attachments/${id}`);
    expect(after.headers['x-neiliro-encryption']).toBe('1');
    expect(after.body).toBe('NE1 sealed bytes');
    // The id survived: note markdown pointing at /api/attachments/<id> still resolves
    expect(after.statusCode).toBe(200);
  });
});

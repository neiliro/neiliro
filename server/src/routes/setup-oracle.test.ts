import { beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type Harness } from '../test-harness.js';

/*
  The setup route must not tell a stranger whether a hub exists (#252).
  A ghost answers 403 "already set up" to anything; a real, initialised
  hub used to validate the body first and answer 400 to junk — one request
  with an empty body was enough to tell the two apart. Both now refuse in
  the same words before looking at the body.
*/
let h: Harness;

beforeAll(async () => {
  h = await buildTestApp();
  h.join('Alice'); // the hub has its admin: initialised
});

describe('an initialised hub', () => {
  it('refuses setup with the ghost’s words whatever the body looks like', async () => {
    for (const body of [{}, { email: 'not-an-email' }, { name: 'x', email: 'x@y.example', auth_key: 'A'.repeat(43), kdf_salt: '00'.repeat(16), accept_terms: true }]) {
      const res = await h.as('', 'POST', '/api/auth/setup', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(403);
      expect(res.json<{ error: string }>().error).toBe('The hub is already set up');
    }
  });
});

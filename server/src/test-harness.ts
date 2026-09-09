import { deriveAuthKey } from './lib/kdf.js';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from './app.js';
import { openDatabase, runWithDb, id, now } from './db/index.js';
import { migrate } from './db/migrate.js';
import { SESSION_COOKIE, createSession } from './lib/auth.js';

/*
  Test support: the real app, an in-memory database, and two people.

  Shared rather than copied into each test file so there is one obvious
  thing to reuse — the first version of this lived inside guards.test.ts,
  and a second test would have started by copying it.

  The database is bound with an onRequest hook, exactly the way demo mode
  binds a request to a visitor's sandbox. Wrapping app.inject() in
  runWithDb does not work: the request is dispatched onto its own async
  chain and the AsyncLocalStorage context does not follow it.
*/

export interface Harness {
  app: FastifyInstance;
  db: Database;
  /** Adds a user and returns a session cookie value for them. */
  join(name: string): { userId: string; cookie: string };
  /** A request as that person, inside the test database. */
  as(cookie: string, method: InjectOptions['method'], url: string, payload?: unknown): Promise<{
    statusCode: number;
    body: string;
    json<T>(): T;
  }>;
}

/**
 * What a browser sends for this password and address (ADR 0001, #211):
 * the derived auth key. Tests that create accounts or sign in go through
 * this, so a payload reads like the wire and not like a plaintext password.
 * Production iteration count on purpose — a temporary password issued by
 * the server must round-trip through the very same derivation.
 */
export const SALT = '00112233445566778899aabbccddeeff';
export const authKey = (password: string): Promise<string> => deriveAuthKey(password, SALT);

export async function buildTestApp(): Promise<Harness> {
  const app = await buildApp();
  const db = openDatabase(':memory:');
  app.addHook('onRequest', (_req, _reply, done) => runWithDb(db, done));
  runWithDb(db, () => migrate());

  return {
    app,
    db,
    join(name) {
      return runWithDb(db, () => {
        const userId = id();
        db.prepare(
          `INSERT INTO users (id, email, name, role, password_hash, created_at)
           VALUES (?, ?, ?, 'admin', 'x', ?)`,
        ).run(userId, `${name}@hub.local`, name, now());
        return { userId, cookie: createSession(userId, `${name}-device`) };
      });
    },
    as(cookie, method, url, payload) {
      const options: InjectOptions = {
        method,
        url,
        headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
      };
      if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
      return app.inject(options);
    },
  };
}

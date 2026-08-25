import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
  Every environment variable the server reads has to be documented.

  This exists because documentation drifts silently: a variable added to
  env.ts works immediately, so nothing forces the person adding it to
  mention it anywhere an operator would look. `.env.example` is that
  place — it is what a self-hoster copies and what the hosted runbook
  points at — and it has fallen behind before.

  The check is one-directional: env.ts -> .env.example. The reverse would
  fail on the infrastructure variables that only compose, Caddy and the
  backup script read (HUB_DOMAIN, AGE_RECIPIENT, DEMO_DATA_DIR …), which
  are legitimately absent from the server's own code.
*/

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_TS = join(HERE, 'env.ts');
const ENV_EXAMPLE = join(HERE, '..', '..', '.env.example');

/*
  Set by the container or the process, never by a human editing .env, so
  documenting them in a copy-me file would be noise. Each one needs a
  reason to be here — that is the point of the list.
*/
const NOT_FOR_HUMANS = new Set([
  'NODE_ENV', // set by the image
  'HOST', // bind address; the container always wants 0.0.0.0
  'WEB_DIST', // build layout, not deployment
  'DATA_DIR', // written by compose from the documented DATA_DIR mount
  'TRUST_PROXY', // compose sets it: mandatory behind Caddy, unsafe without
  'SECURE_COOKIES', // same — compose decides, and .env.example explains the flag itself
  'PUBLIC_URL', // compose builds it from HUB_DOMAIN
  'DEMO_MODE', // the demo overlay sets it
]);

/** `process.env.FOO`, plus the validated forms `intFrom('FOO'` / `boolFrom('FOO'`. */
function readsFromEnv(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]!);
  for (const m of source.matchAll(/(?:intFrom|boolFrom)\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1]!);
  return names;
}

describe('environment documentation', () => {
  const source = readFileSync(ENV_TS, 'utf8');
  const example = readFileSync(ENV_EXAMPLE, 'utf8');
  const read = readsFromEnv(source);

  it('found the variables at all', () => {
    // Guards the regexes themselves: a rename in env.ts must not turn this
    // suite into a test that silently checks nothing.
    expect(read.size).toBeGreaterThan(10);
    expect(read.has('HOSTED_MODE')).toBe(true);
  });

  it('documents every operator-facing variable in .env.example', () => {
    const documented = new Set(
      [...example.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]!),
    );
    const missing = [...read].filter((name) => !NOT_FOR_HUMANS.has(name) && !documented.has(name));
    expect(missing.sort()).toEqual([]);
  });

  it('keeps the exemption list honest', () => {
    // An exemption for a variable env.ts no longer reads is stale, and a
    // stale exemption is how a real variable slips through later.
    const unused = [...NOT_FOR_HUMANS].filter((name) => !read.has(name));
    expect(unused.sort()).toEqual([]);
  });
});

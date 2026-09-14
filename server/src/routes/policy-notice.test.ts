import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/*
  The in-app half of the promise both legal documents make (#229): a
  material change is announced before it takes effect. The notice is a
  property of the process, read from env — so it has to appear identically
  on a real family and on the ghost (a notice that showed only on real
  subdomains would enumerate them), and never off the hosted service.

  env.ts reads the environment at import time, so the flags are set before
  any app module is pulled in — hence the dynamic imports, as in
  hosted.test.ts.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.POLICY_NOTICE_URL = 'https://neiliro.test/privacy#changes';
process.env.POLICY_NOTICE_EFFECTIVE = '2026-10-15';

const tenants = await import('../lib/tenants.js');
const { buildApp } = await import('../app.js');

afterAll(() => {
  for (const k of ['HOSTED_MODE', 'HOSTED_DOMAIN', 'POLICY_NOTICE_URL', 'POLICY_NOTICE_EFFECTIVE']) delete process.env[k];
  tenants.shutdownHosted();
});

describe('a pending change to the terms or the privacy policy', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    tenants.initHosted();
    tenants.createFamily('smiths-a1b2');
    app = await buildApp();
  });

  it('is announced in the process state, the same on a family and on the ghost', async () => {
    const family = await app.inject({ url: '/api/auth/state', headers: { host: 'smiths-a1b2.neiliro.test' } });
    const ghost = await app.inject({ url: '/api/auth/state', headers: { host: 'nosuch-x9y8.neiliro.test' } });
    expect(family.json().policy_notice).toEqual({
      url: 'https://neiliro.test/privacy#changes',
      effective: '2026-10-15',
    });
    expect(ghost.json().policy_notice).toEqual(family.json().policy_notice);
  });
});

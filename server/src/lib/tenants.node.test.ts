import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
  ADR 0002, phase 0: the registry can say "this family is not here".

  A row whose `node` names another machine must be invisible to every
  reader that means "the families on this node" and refused by the one
  function that would otherwise create an empty hub for it. This file
  pins that — and pins the one reader that is deliberately global.

  env.ts reads the environment at import time, hence the flags first and
  the dynamic imports after, as in routes/hosted.test.ts.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.NODE_NAME = 'hosted01';

const tenants = await import('./tenants.js');
const { env } = await import('../env.js');
const { db } = await import('../db/index.js');

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  delete process.env.NODE_NAME;
  tenants.shutdownHosted();
});

const registry = () => new Database(join(env.dataDir, 'registry.db'));

describe('a family placed on another node', () => {
  let localId: string;
  const remoteId = 'remote-0000-1111-2222-333333333333';

  beforeAll(() => {
    tenants.initHosted();
    localId = tenants.createFamily('smiths-here').familyId;
    // What control's registry holds for a family on a shard: id, slug,
    // node, status — written by control's sign-up flow in phase 1; here by hand.
    const r = registry();
    r.prepare("INSERT INTO nodes (name, url, accepting, created_at) VALUES ('hosted02', '10.110.0.5:8787', 1, ?)").run(
      '2026-09-15 12:00:00',
    );
    r.prepare(
      "INSERT INTO families (id, slug, status, created_at, node, founder_email, plan) VALUES (?, 'jones-there', 'active', '2020-01-01 00:00:00', 'hosted02', 'jones@example.test', 'trial')",
    ).run(remoteId);
    r.close();
  });

  it('is not resolved by its slug: a browser meets the ghost, the mail webhook meets null', () => {
    const byHost = tenants.resolveTenant('jones-there.neiliro.test');
    expect(byHost.ghost).toBe(true);
    expect(tenants.tenantForSlug('jones-there')).toBeNull();
    // and the local one still works both ways
    expect(tenants.resolveTenant('smiths-here.neiliro.test').familyId).toBe(localId);
    expect(tenants.tenantForSlug('smiths-here')?.familyId).toBe(localId);
  });

  it('is refused by tenantFor, naming the node, and no directory appears for it', () => {
    expect(() => tenants.tenantForFamily(remoteId)).toThrow(/lives on node hosted02/);
    expect(existsSync(join(env.dataDir, 'families', remoteId))).toBe(false);
    // the hazard this guards: before the column, this call created a blank hub
    expect(existsSync(join(env.dataDir, 'families', localId, 'hub.db'))).toBe(true);
  });

  it('is skipped by forEachFamily', async () => {
    const visited: string[] = [];
    await tenants.forEachFamily(() => {
      // inside the job the tenant is the current one — record who we are in
      visited.push(db.name);
    });
    expect(visited).toHaveLength(1);
    expect(visited[0]).toContain(localId);
  });

  it('is absent from the population readers, present for the global one', () => {
    // sweeps and letters run on the owning shard — a remote row is not this node's business
    expect(tenants.familiesWithPlans().map((f) => f.id)).toEqual([localId]);
    expect(tenants.signupFamiliesCreatedBefore('2030-01-01 00:00:00').map((f) => f.id)).toEqual([]);
    // sign-up dedupe runs on control, which holds every family's row — it must see the shard's
    expect(tenants.pendingFamilyByFounderEmail('jones@example.test')).toBe(remoteId);
  });

  it('leaves the slug ledger global: the remote slug is taken here too', () => {
    expect(() => tenants.createFamily('jones-there')).toThrow(/already taken/);
  });
});

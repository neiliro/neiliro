import { existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

/*
  A shard never writes the gateway's map (ADR 0002: control knows WHERE).
  Its registry holds only its own families, so a map rendered from it
  would be empty at best and wrong at worst. env is read at import time,
  hence its own file with CONTROL_URL set before the imports.
*/
process.env.HOSTED_MODE = 'true';
process.env.HOSTED_DOMAIN = 'neiliro.test';
process.env.CONTROL_URL = 'http://10.110.0.2:8787';

const tenants = await import('./tenants.js');
const { routeMapPath } = await import('./route-map.js');

afterAll(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_DOMAIN;
  delete process.env.CONTROL_URL;
  tenants.shutdownHosted();
});

describe('a shard', () => {
  it('starts, creates families and writes no route map', () => {
    tenants.initHosted();
    tenants.createFamily('shard-born');
    tenants.writeRouteMap();
    expect(existsSync(routeMapPath())).toBe(false);
  });
});

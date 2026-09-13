import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-harness.js';

/*
  A hub is nobody's web page (#269). Family hosts on the hosted service
  carry the family's name in the address, and a search engine indexing
  their sign-in screens would list the families the ghost exists to hide;
  a self-hosted hub is private just the same. Every answer says so.
*/
describe('search engines are told to stay out', () => {
  it('robots.txt disallows everything and every response carries X-Robots-Tag', async () => {
    const { app } = await buildTestApp();
    const robots = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers['content-type']).toContain('text/plain');
    expect(robots.body).toBe('User-agent: *\nDisallow: /\n');
    expect(robots.headers['x-robots-tag']).toBe('noindex, nofollow');

    const state = await app.inject({ method: 'GET', url: '/api/auth/state' });
    expect(state.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

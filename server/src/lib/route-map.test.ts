import { describe, expect, it } from 'vitest';
import { renderRouteMap } from './route-map.js';

/*
  The exact bytes the gateway imports (ADR 0002, Routing). Pinned because
  the reader is Caddy's tokenizer, not a person: a stray character here is
  a refused reload there.
*/
describe('renderRouteMap', () => {
  it('is one "host upstream" line per remote family, sorted, nothing else', () => {
    const text = renderRouteMap(
      [
        { slug: 'petrovy-k3f9', node: 'hosted02', url: '10.110.0.5:8787' },
        { slug: 'ivanovy-a1b2', node: 'hosted03', url: 'hosted03.internal:8787' },
      ],
      'neiliro.test',
    );
    expect(text).toBe('ivanovy-a1b2.neiliro.test hosted03.internal:8787\npetrovy-k3f9.neiliro.test 10.110.0.5:8787\n');
    expect(text).not.toMatch(/map|default|[{}]/);
  });

  it('is empty — not a default line — on a single node', () => {
    // the Caddyfile owns `default`; an imported one would be a second
    expect(renderRouteMap([], 'neiliro.test')).toBe('');
  });

  it('refuses to render anything that would not tokenize, naming the cause', () => {
    expect(() => renderRouteMap([{ slug: 'ok-family', node: 'hosted02', url: '10.110.0.5:8787 {' }], 'x.test')).toThrow(
      /would not tokenize/,
    );
    expect(() => renderRouteMap([{ slug: 'ok-family', node: 'hosted02', url: 'no-port' }], 'x.test')).toThrow(/tokenize/);
    expect(() => renderRouteMap([{ slug: 'Bad Slug', node: 'hosted02', url: '10.0.0.1:1' }], 'x.test')).toThrow(/not well-formed/);
  });

  it('refuses a family placed on a node the registry does not know', () => {
    expect(() => renderRouteMap([{ slug: 'lost-family', node: 'hosted09', url: null }], 'x.test')).toThrow(
      /placed on node "hosted09", which is not in nodes/,
    );
  });
});

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from '../env.js';
import { isWellFormedSlug } from './tenants.js';

/*
  The gateway's route map (ADR 0002, Routing).

  Caddy decides which node answers for a hostname from a `map` whose
  entries this file provides: one line per family that lives on ANOTHER
  node, `<slug>.<apex> <node url>`. Nothing else — no `map`, no `default`.
  The Caddyfile in neiliro/cloud owns those, so that a missing or empty
  file is a map with only the default (this node's app), which is exactly
  the single-node stack. A glob import that matches no file adapts fine,
  but an imported `default` that is absent leaves {upstream} empty and
  every request a 502 — found the day the Caddy side was tried, and the
  reason the default is not ours to write.

  The file lives in its own directory because the gateway bind-mounts a
  DIRECTORY: a bind-mounted file pins its inode, and the atomic write
  below (temp file + rename) is a new inode every time — Caddy would
  read the first version forever.

  Only control writes it. A shard (CONTROL_URL set) holds rows for its
  own families only and knows nothing about placement.
*/

export function routeMapPath(dataDir = env.dataDir): string {
  return join(dataDir, 'gateway', 'routes.caddy');
}

export interface Placement {
  slug: string;
  /** The owning node's app address as the gateway reaches it, host:port. */
  url: string | null;
  node: string;
}

/*
  What may follow a hostname on a map line. The Caddyfile tokenizer is
  the reason this is strict: a space, a brace or a quote in an upstream
  would not be an odd route, it would be a parse error at reload — and
  the sidecar would refuse the whole map. A hostname or an IPv4 address,
  a colon, a port.
*/
const UPSTREAM_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:\d{1,5}$/;

/**
 * The map's text for a set of placements. Pure, and deterministic: lines
 * are sorted, so the same placement set is the same bytes and the reload
 * sidecar — which compares checksums — does nothing when nothing moved.
 *
 * Throws rather than writes anything doubtful. A family placed on a node
 * the registry does not know, or a node whose url would not tokenize, is
 * an integrity problem to fix by hand; the previous map keeps serving
 * meanwhile, which is the same fail-closed outcome as a refused reload,
 * only with the cause named in our log instead of Caddy's.
 */
export function renderRouteMap(placements: Placement[], apex = env.hostedDomain): string {
  const lines: string[] = [];
  for (const p of placements) {
    if (!isWellFormedSlug(p.slug)) throw new Error(`route map: slug "${p.slug}" is not well-formed`);
    if (p.url === null) throw new Error(`route map: family ${p.slug} is placed on node "${p.node}", which is not in nodes`);
    if (!UPSTREAM_RE.test(p.url)) throw new Error(`route map: node "${p.node}" has an upstream that would not tokenize: "${p.url}"`);
    lines.push(`${p.slug}.${apex} ${p.url}`);
  }
  lines.sort();
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

/** Write the rendered map atomically: a reader sees the old file or the new one, never a torn one. */
export function writeRouteMapFile(content: string, path = routeMapPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

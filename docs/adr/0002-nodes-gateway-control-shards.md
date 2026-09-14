# ADR 0002 — More than one machine: a gateway, a control node, shards

**Status:** proposed 2026-09-14 · **Epic:** to be opened once accepted

## Context

Hosted Neiliro runs on one machine. Every family is a subdomain and one
SQLite file; a per-machine `registry.db` maps slug → id, status and plan;
Caddy holds the wildcard certificate and proxies every hostname to the
one app process. Measured comfort is ~300 active families on that
machine, and the arithmetic in the cloud runbook says a thousand would
not saturate a core. Load is not why this ADR exists.

Two other things are:

- **A second machine cannot be added today without a redesign.** The
  architecture already says *shard, don't balance* — a family's database
  is opened by exactly one process, shared storage is banned — but the
  code stops at "one process on one machine". Everything below quietly
  assumes the family lives *here*:
  - the registry is per machine, and slug uniqueness is a local `UNIQUE`
    index plus a local `retired_slugs` table;
  - the reserved hosts `signup.`, `billing.`, `auth.` and `in.<apex>` find
    the family in the local registry or in process memory — the Google
    sign-in ticket lives in a `Map`, the Paddle webhook looks the family
    up by id, the mail webhook by recipient slug;
  - `forEachFamily()` — every sweep, the reaper, plan letters, the IMAP
    poller — treats the local registry as the whole population;
  - backups name the registry archive `registry.db.age`, stats are one
    `hosted-stats.db`, the deploy knows one host.
- **One machine is one blast radius.** The families are paying now. When
  the machine dies at 04:00 they are down until the operator wakes up,
  with up to a day of writes lost (backups run at 03:00). Active-active
  is off the table by the SQLite decision; what *is* on the table is a
  fast, rehearsed rebuild — and that needs the same primitive as adding
  a machine: put a set of families on a node that did not have them.

The question this ADR answers: **what has to be true in the code and the
stack so that a second machine is an operation, not a project — and so
that the same operation rebuilds a dead one.**

## Decision

**Roles, not machines.** The hosted stack has three roles. One node plays
all three today; a second node plays only the third. Nothing changes for
a single-node deployment, and self-hosted is untouched.

| role | what it owns | today |
|---|---|---|
| **gateway** | the wildcard certificate; routes each hostname to the node that owns the family; unknown hostnames go to control | hosted01's Caddy |
| **control** | the authoritative registry (every family, every node), the slug ledger, the `nodes` table, the reserved hosts, the placement of new families | hosted01's app |
| **shard** | the families placed on it: their databases, files, sessions, plan letters, sweeps | hosted01's app |

### Routing: the gateway maps hostnames, and placement never leaks

The gateway is Caddy with a `map {host} → upstream` whose entries are
exported by control from the registry, with **control's own app as the
default upstream**. A family on a shard is routed there over the VPC; a
family on control, a reserved host and an unknown name all go to
control, where the unknown name meets the ghost as it does today.

From outside, every hostname behaves identically whatever node it lives
on. That is the property the ghost and the wildcard certificate exist to
protect, and it rules out the obvious cheaper alternative — see
*Rejected*.

The map is data: control writes it (a Caddyfile snippet under its data
directory) whenever placement changes and at startup; the stack reloads
Caddy when the file changes (graceful, zero-downtime). How exactly the
reload is triggered is the cloud repository's business; the contract is
the file.

### Truth: control knows *where*, the shard knows *what*

The registry table `families` gets a `node` column (`NULL` = this node)
and the registry gets a `nodes` table (`name`, `url`, `accepting`).

- **Control holds a row for every family in the service.** For a family
  on another node that row carries only what routing and uniqueness
  need: id, slug, node, `status` (active or deleted), `deleted_at`,
  `founder_email`. The `UNIQUE` index on `slug` and `retired_slugs` are
  therefore **global** — one place answers "is this address available",
  and the year-long hold on a deleted family's address still holds
  service-wide.
- **The owning shard holds the truth about its families**: full status,
  plan and Paddle fields, `plan_letters`, `billing_events`, the database
  and attachments. Its registry lists only its own families. Everything
  that runs per family — sweeps, the reaper, plan letters, the wall,
  sessions, rate limits, TOTP, the login lockout — runs on the shard and
  needs nothing from anywhere else. A family's traffic all lands on one
  node, so per-process state stays correct per family.
- Every place that reads the registry as "the population" — `allFamilies`,
  `familiesWithPlans`, `signupFamiliesCreatedBefore`, `familyIdBySlug` —
  filters to local rows. `tenantFor()` **refuses** a remote family id: today
  it would create an empty hub for it, and that hazard becomes real the
  day two registries exist.

### Reserved hosts: control receives, the owner handles

The four reserved hosts keep their addresses and their checks. Control
answers them and, when the family is elsewhere, **proxies the request to
the owning shard with the `Host` header preserved**, so the shard runs the
very same handler with the very same host check.

| flow | how control finds the owner | what changes in the code |
|---|---|---|
| `billing.` Paddle webhook | `custom_data.family_id` → `families.node` | raw body and `Paddle-Signature` are forwarded byte-for-byte; the shard verifies the signature itself (same secret in every node's env) |
| `in.` Mailgun webhook | `recipient` slug → `families.node` | the form is forwarded as received; the signature covers `timestamp + token`, not the body, so forwarding keeps it valid; Message-ID idempotency lives in the family's database, so a retry that lands twice is still one letter |
| `auth.` Google callback | the OAuth `state` carries the slug as a prefix, minted by the shard that started the flow | `pending` and `handoffs` stay in-process **on the shard**; control only routes. The finish redirect to `<slug>.<apex>` reaches the shard through the gateway as before |
| `signup.` | control *is* the owner of this flow | control draws the slug, checks the global ledger, mints the id, records the row with `node = <accepting shard>`, then asks that shard to create the family and send the founder's invitation. Dedupe by founder e-mail reads control's rows; "has the family been claimed" asks the shard |

Two things flow the other way, shard → control, and both **fail closed**:
a family's one-time rename (the ledger must say yes first) and a family's
deletion (retire the slug, drop the route). If control is unreachable the
shard answers 503 for those two operations; everything else on the shard
keeps working. Control being down costs new sign-ups, payments arriving,
mail arriving, Google sign-in and control's own families — not the
service.

### Internal transport

Plain HTTP over the DigitalOcean VPC. Each node's app port is bound to
its VPC address only, the fleet firewall opens it to droplets carrying
the fleet tag and to nothing else, and every internal request carries a
shared secret in a header. A shard accepts a reserved-host request only
with that header — which also closes the finding from the 09.09 QA run
that the mail webhook answered on any family host.

What travels inside the VPC in the clear: session cookies and request
bodies of families on shards. Their words are encrypted in the browser
(ADR 0001); what a VPC eavesdropper would see is structure. Accepted for
now; mutual TLS between nodes is a contained later change if the threat
model ever asks for it.

### Moving a family

Not needed for capacity — new families simply go to the node marked
`accepting` — but needed for evacuation and for rebuilding a dead node,
so the primitive is part of the design:

1. control marks the family suspended (its node stops serving it);
2. the owner produces a **bundle**: its registry row, `VACUUM INTO` of
   the database, attachments — the shape `/api/family/export` already
   streams;
3. the target imports the bundle under the same id, control flips `node`,
   the route map reloads, the source removes its copy.

Restoring a node from R2 is the same loop with the bundles coming from
the bucket instead of a live source, and control's rows saying which
families it must hold. Seconds of downtime per family, no shared storage,
nothing a family notices beyond signing in again.

### Consequences for availability

- `*.<apex>` points at a **DigitalOcean reserved IP** assigned to the
  gateway node, not at the droplet. Rebuilding or replacing the gateway
  is "assign the IP", not a DNS change with a TTL.
- **A node from nothing is a workflow** in `neiliro/infra`, modelled on
  `range-up`: droplet in the fleet VPC and firewall, cloud-init, the
  stack from `neiliro/cloud`, env from secrets, registration in control's
  `nodes` table. The same workflow with "restore from R2" is the
  disaster-recovery path, and it gets rehearsed on the range before it is
  ever needed in anger.
- **Backups become per node** (`registry-<node>.db.age`; family archives
  are already id-named and need no change) and **incremental**: every
  changed family database goes to R2 every fifteen minutes on top of the
  nightly full set. RPO goes from a day to a quarter of an hour without a
  new component — it is `backup.sh` with a filter.
- The release deploy runs over every node, shards first, control last:
  control's client code must not be newer than the shards it talks to.
- Monitoring probes each node's health over the VPC, and the exporters
  are already opened to the fleet tag.

## What this does not do

- It does not balance. A family lives on exactly one node; the gateway
  routes, it does not distribute.
- It does not make control redundant. Control is the one component that
  is still singular, and the bet is that its outage is bounded (see
  above) and its rebuild is fast (reserved IP + restore). A standby
  control is a later ADR, if ever.
- It does not change the request path on a shard. Once routed, a request
  is served exactly as it is today: same tenant resolution, same pool,
  same wall.
- It does not touch self-hosted mode. Without `HOSTED_MODE` none of this
  exists.

## Rollout

Three phases; the first has no second machine and no visible change.

**Phase 0 — the beachhead (one node, zero behaviour change).**
`families.node`, the `nodes` table, `NODE_NAME` in env, the local-only
predicates and the `tenantFor` guard; the route-map export with control
as the only entry and Caddy importing it; the reserved IP in front of
hosted01; `registry-<node>` in backups; the incremental backup run; the
internal secret in env. Each of these is a small PR that ships on its
own.

**Phase 1 — the second node.** The internal API and the four proxies;
rename and deletion reporting to control; a two-instance test harness
(two real listeners in one vitest run); the shard compose profile (no
Caddy, VPC bind); the firewall rule; `node-up` in infra;
`release-deploy` over all nodes; runbook chapters *Adding a node* and
*Where does this family live*. Exit: a family created through the real
sign-up form lands on a second range droplet and receives mail, pays and
signs in with Google.

**Phase 2 — moving and rebuilding.** The bundle export/import;
`move-family`; restore-a-node from R2; stats and the weekly report across
nodes; a gateway failover drill (assign the reserved IP to a rebuilt
node) on the range, timed.

## Rejected alternatives

- **DNS per family** — wildcard → node 1, an explicit A record for every
  family on node 2. No gateway, no extra hop, and an oracle: any name
  that resolves to node 2's address is certainly a real family. That is
  precisely the enumeration the ghost exists to prevent.
- **Routing inside control's app** (the app looks placement up and
  proxies). No Caddy plumbing, but every request to every shard passes
  through control's single Node process — control down means everyone
  down. The Caddy map keeps shards serving while control is out, and
  keeps Node out of the hot path.
- **A shared registry** — SQLite on a network filesystem is banned (WAL
  coordinates through shared memory; it corrupts, it does not slow
  down), Postgres is ruled out by the architecture, and a hosted KV in
  the per-request path trades one machine's availability for a
  provider's. Control's copy of the rows is small, written rarely, and
  read only by the flows that already terminate on control.
- **Cloudflare in front (proxy or load balancer)** — TLS would terminate
  off the box. The wildcard certificate is held by our Caddy by decision,
  and the privacy policy describes exactly that.
- **K processes on one machine** (the runbook's item 5) — good for
  rolling deploys and blast radius, and it does not survive the machine.
  It can still be done per node later; the node model does not preclude
  it.

## Related

- Runbook, *Capacity — measured, not guessed* and *Scaling — what breaks,
  in what order* (`neiliro/cloud/README.md`) — the numbers this ADR
  stands on.
- ADR 0001 — why what travels inside the VPC is structure, not words.
- `neiliro/infra` `range-up` — the shape `node-up` copies.

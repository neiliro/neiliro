# Architecture

The technical decisions and the reasoning behind them. For user-facing
behaviour, see [features.md](features.md); for the conventions to follow
when changing any of this, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Layout

```
server/               Fastify + SQLite
  src/db/migrations/  Schema. The single source of truth
  src/routes/         API
web/                  React + Vite + Tailwind
scripts/              Certificates, backups, export/import, admin reset
```

Data lives **outside the project folder** — in `~/.family-hub` (or the mounted volume): database, attachments, backups. Replacing the code never touches it.

One process serves everything in production: Fastify answers the API and hands out the built frontend. No external services are required — sign-in, search, files and backups are all local.

## Database

The schema lives in `.sql` files and is applied at startup. A new migration is a new file with the next number; already-applied ones are never re-run.

Database access is plain SQL through better-sqlite3, no ORM. At the scale of a thousand notes an ORM does not pay for itself, while the schema is described in exactly one place and cannot drift from the code.

Search uses FTS5 with the `trigram` tokenizer. It matches substrings, so morphology in any language works without a stemmer — a search for the stem of a word finds all its inflected forms (Cyrillic included: «переезд» finds «переезда» and «переездом»). The price is a three-character minimum per query.

SQLite's built-in `lower()` and `LIKE` are case-insensitive only for Latin, so task-name search registers a custom `ci_contains` function — it folds case in JavaScript and knows every alphabet.

Passwords are hashed with scrypt from Node's standard library. The sessions table stores a sha256 of the token, not the token itself: someone who reads the database cannot impersonate anyone.

## Time

Everything a person enters or reads is local wall-clock time, server included: due dates, "today" on the dashboard, recurring transaction dates, calendar events and note placeholders are computed in the `TZ` time zone. Otherwise everything would live in "yesterday" between midnight and one-two a.m., and "every Tuesday at 10:00" would drift with DST. A household lives in one time zone; set `TZ` accordingly.

Machine timestamps are the deliberate exception: `created_at`, `updated_at`, session stamps and note-version times are written in UTC (`now()` in `db/index.ts`, and the `datetime('now')` column defaults). They are never compared against a wall-clock date — only against each other — so one monotonic scale is the safer choice, and it survives a server that changes time zone. The rule of thumb when adding a column: a date a person picked is local, a moment the machine recorded is UTC.

## Money

Amounts are integers in minor units (1234.56 → 123456): floating point in money accumulates rounding errors. Balances, reconciliation baselines and "which recurring payments are due" are always computed from history rather than stored — a stored value drifts after any backdated edit, a computed one cannot. The full semantics live in [features.md](features.md), "Money".

## Logging

The level is set with `LOG_LEVEL`: `debug` · `info` · `warn` · `error` · `silent`. **The default is `warn`** — in normal operation only warnings and errors are interesting.

Fastify's built-in logger is disabled entirely. It wrote a JSON line per request, pid and hostname included; on a home server polled by a kiosk once a minute that is noise in which a real error disappears.

What is written at which level:

| Level | What you see |
|---|---|
| `debug` | plus a line per request with duration |
| `info` | plus one-off events like created recurring transactions and sign-ins with IPs |
| `warn` | 4xx responses: something not found, something failed validation |
| `error` | 5xx responses with stack traces, crashes, an occupied port |
| `silent` | nothing |

The format is one line: `12:31:19 WARN  404 GET /api/nope`.

One-off critical messages print **regardless of level**, even at `silent`: applied migrations are the only trace that the database changed, and the startup line says the server is up.

Malformed path or query parameters answer 400 and log as `WARN`. Previously that crashed with a 500 and looked like a server error in the log.

## Tests

`app.ts` builds the HTTP surface — hooks, plugins, routes — and `index.ts` starts the world: migrations, the session pruner, the port, the mail poller, signal handlers. The split exists for one reason: importing the app must not start a server. Before it, the guards that carry the privacy promise could not be tested at all, because reaching them meant listening on a port.

With it, a test builds the same app the process does and drives it through `inject()` against an in-memory database. The database is bound per request with an `onRequest` hook — which is the same mechanism demo mode uses to route a visitor to their sandbox. That layer was built for the public demo and turned out to be exactly what makes route tests possible; the alternative would have been threading a database argument through every route.

Two checks read the source instead of calling it: every `t()` key must exist in the Russian dictionary, and every migration must apply to an empty database. They catch what no single test can, because nothing is wrong at any one call site.

What is deliberately not covered: anything whose failure is visible rather than logical — colours, spacing, dark-theme contrast, the service worker. Those are checked by looking, and asserting on class names would break on every redesign without ever catching a bug.

## Demo mode

`DEMO_MODE=true` turns the hub into a public sandbox where **every visitor gets their own throwaway copy** of a seeded sample family. One button to enter — no password.

Under the hood the app builds a template database at startup (migrations + seeding, rebuilt daily so the seeded dates stay fresh) and clones the file per visitor — a copy costs milliseconds. Each request is routed to its visitor's database through an `AsyncLocalStorage` context, so route code is identical in normal and demo modes. A sandbox disappears after a couple of idle hours, on sign-out, or when the app restarts; oversized sandboxes and the least-recently-used ones past a cap are dropped too.

Visitors can create, edit and delete anything — nobody else will ever see it, which is the point: a shared demo is a graffiti wall by lunchtime. What stays blocked is everything that would outlive the sandbox or reach the outside world: password and membership changes, invitations, file uploads, two-factor setup, Google linking, and the mailbox — its settings, manual sync and sending. Reading the seeded letters and turning one into a task stay open, since that is the part worth showing.

Deploying a public demo next to a production hub: [deploy-vps.md](deploy-vps.md), "Public demo".

## Offline and updates

The frontend is a PWA: a service worker precaches the app shell and answers GET API reads NetworkFirst — fresh when online, the last snapshot when not. Nothing external is involved (the strict CSP allows no third-party scripts); workbox is bundled and self-hosted. Auth is uncached except the single `auth/me` read, without which an offline reload would strand the person on the sign-in screen; signing out — or any 401 — deletes the offline caches, so cached family data never outlives a session.

The same worker solves the long-lived-tab problem: a kiosk that stays open for weeks runs whatever bundle it started with, because a SPA re-reads `index.html` only on full navigation. A deploy now produces a waiting worker, the client shows a "hub was updated" toast, and a tab idle for 15+ minutes reloads itself. The demo never registers the worker: sandboxes are per-visitor, browser caches are not.

### Which build is running

Settings → About and the foot of the sidebar name the version and the commit the bundle was built from. The version comes from the root `package.json` at build time; the commit arrives as the `BUILD_SHA` Docker build argument, because `.dockerignore` keeps `.git` out of the image. A build from source shows the version alone — a dev bundle has no commit worth quoting.

Both are visible only behind the sign-in screen. `/api/health` withholds the version from the public internet deliberately, and a line under the login box would have handed it to every scanner instead.

A hand-rolled `docker build` should pass `--build-arg BUILD_SHA=…`; without it the commit line simply disappears.

### Cutting a release

1. Everything merged and the docs caught up — both are written in the same pull requests as the code, not gathered up afterwards.
2. Bump the version in all three `package.json` files in that day's last pull request, before tagging. Settings → About and the sidebar read it, so a manifest left behind announces the wrong release.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The tag starts `release.yml`: a multi-arch image (amd64 + arm64) to GHCR, 6–9 minutes, most of it arm64 under emulation.
5. Write the release page by hand — [v1.0.0](https://github.com/neiliro/neiliro/releases/tag/v1.0.0) is the shape: a title that names the release, what it means in a paragraph, a section per headline feature, and an **Upgrading** block naming the migrations that will run and the exact image to pull. Generated notes do not do that job.
6. Close the milestone, if one is open.

The git tag carries a `v` and the image tag does not — `v1.1.0` in the repository, `ghcr.io/neiliro/neiliro:1.1.0` in the registry. That is `docker/metadata-action` following registry convention (`node:22`, `postgres:16` carry no prefix), not a prefix going missing. It reads like a bug often enough to be worth writing down.

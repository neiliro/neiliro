# Contributing

Thank you for looking. This is a small, opinionated app that a family
actually runs their week on, and that shapes what a good change looks
like here more than any style rule does.

Two things worth knowing before you start:

- **The product is deliberately finished.** Tasks, notes, calendar and
  money work a particular way on purpose. A change that adds a setting
  so that two behaviours can coexist is usually the wrong shape; a
  change that picks one and explains why is the right one.
- **It runs in people's homes.** There is no ops team, no staging, and
  the person who wakes up to a broken hub is the same person who cooks
  breakfast. Boring and correct beats clever.

## Getting it running

Node 22 or newer. No database to install — SQLite lives in a file.

```bash
npm install
npm run dev
```

The API comes up on `http://localhost:8787`, the frontend on
`http://localhost:5173`. Open the frontend: an empty hub offers to create
the first account, and that account becomes the administrator.

Data lands in `~/.family-hub`, outside the project folder, so nothing you
do to the repository touches it. To start from scratch, delete that
directory. To keep a throwaway hub beside your real one, point `DATA_DIR`
somewhere else:

```bash
DATA_DIR=~/.family-hub-scratch npm run dev
```

Want realistic data to look at instead of an empty hub? `DEMO_MODE=true`
seeds a sample family and hands every visitor their own copy.

## Where to start

Issues labelled [good first issue][gfi] are real, self-contained, and
written to be picked up cold: each one names the cause with a
`file.ts:line`, says what the correct behaviour is, and suggests a fix.
If one of them turns out to be wrong or bigger than described, say so in
the issue — that is useful information, not a failure.

For anything larger than a bug fix, open an issue first and let's agree
on the shape. It is a small codebase with strong opinions; a day of your
work is worth ten minutes of arguing about the approach.

[gfi]: https://github.com/neiliro/neiliro/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22

## Before you open a pull request

Three commands. CI runs exactly these and nothing else, so a green run
locally is a green run there:

```bash
npm run typecheck
npm run lint
npm test
```

Branch from `master` — always from `master`, never from another branch.
`master` is protected: changes land through pull requests with CI green.

A good pull request explains **why**, not what. The diff already says
what changed. What the reviewer cannot reconstruct is the reasoning: what
you tried, what you rejected, and what you are unsure about. If you
verified something by hand, say what you did and what you saw — that is
often the most valuable paragraph.

Small and focused beats large and thorough. Two unrelated fixes are two
pull requests.

## Writing code here

**There is no formatter.** No Prettier, no EditorConfig — deliberately.
Match the file you are editing: it is consistent, and matching it is
less work than configuring anything. Two-space indent, single quotes,
semicolons, trailing commas in multiline literals.

**The linter is narrow on purpose.** TypeScript's recommended set plus
`react-hooks`, and no taste rules — see `eslint.config.mjs`, which
explains each choice. `react-hooks/exhaustive-deps` is an **error**, not
a warning, and that is not negotiable: unstable hook identities have
caused real incidents in this app (a silent request loop that ate memory
and tripped a rate limit).

**Comments explain why.** The code says what it does; a comment that
repeats it is noise that goes stale. What deserves a comment is the
reasoning a reader cannot recover: why this approach and not the obvious
one, what broke last time, which invariant this line protects. Look at
almost any file here for the register — that style is the house style,
and it is the main thing reviewers will ask you to match.

Comments and identifiers are **in English**, including in files whose
user-facing strings are Russian.

**New dependencies have a high bar.** The hub ships as one container that
people update by hand; every dependency is someone else's breakage
arriving on a family's evening. Prefer the standard library. Native
modules are a particular problem — `better-sqlite3` is already one, and
it is why `node_modules` cannot move between macOS and Linux. Anything
that wants to load a script from a CDN will not work at all: the
Content-Security-Policy forbids external scripts, and that is a feature.

## Rules that are not up for negotiation

These are load-bearing. Breaking one usually produces a change that looks
correct and quietly corrupts something.

**The schema lives in migrations, nowhere else.** `server/src/db/migrations/*.sql`,
applied in filename order, exactly once. Adding a column means adding a
numbered file. **Never edit a migration that has been released** — it has
already run on real databases and will not run again.

**Money is integers in minor units.** `1234.56` is stored as `123456`.
Floating point in money accumulates error that eventually disagrees with
the bank. Currencies are unrelated: no exchange rate anywhere, no total
across currencies.

**Balances are computed, never stored.** Opening balance plus movements,
every time. A stored balance drifts the moment someone edits something
backdated — and people edit things backdated constantly.

**Dates a person picks are local; timestamps the machine records are UTC.**
Due dates, event times and "today" are local wall-clock, via the `today()`
helper that exists on both server and web. `created_at`, session stamps
and the `datetime('now')` column defaults are UTC, via `now()`. Mixing
them produces bugs that only appear between midnight and 2am.
[docs/architecture.md](docs/architecture.md) has the full reasoning.

**Privacy is enforced on the server, by owner, with no exception for the
administrator.** Every route that reads or mutates something by id passes
through its module's visibility predicate — `ACCOUNT_VISIBLE`,
`CALENDAR_VISIBLE`, the `VISIBLE` clause in notes. Hiding a row in the UI
is not privacy. If you add a route that takes an id, the guard is part of
the route, not an afterthought — a missing one is the single most likely
way to introduce a serious bug here.

## Traps this codebase has already fallen into

Learned the hard way, each one more than once.

**A misspelled CSS variable renders nothing, silently.** `var(--c-muted)`
does not exist; `--c-text-muted` does. There is no error — the element
just loses its colour. Check both themes after touching styles.

**Dialogs share one keyboard handler.** `dialogKeys()` in `web/src/lib/keys.ts`,
wired through `Modal`. Enter runs the primary action from anywhere in the
window, Escape closes. Do not add your own listeners — that is how two
handlers end up fighting.

**Amount inputs are filled with `formatAmountInput()`, never `formatAmount()`.**
The localised one inserts a thousands separator that the parser then
refuses, so editing a four-digit amount silently loses it. `formatAmount`
is for display only.

**A stale bundle looks exactly like a fix that did not work.** Twice.
Before concluding the code is wrong, confirm the code you are reading is
the code that is running — hard-reload, and check the service worker
cache if the tab has been open a while.

**`parseAmount('1,500')` returns null on purpose.** The string is
ambiguous between 1.5 and 1500. Not a bug.

## Common tasks

**A user-visible string.** Wrap it in `t()`. The key *is* the English
text — there is no key vocabulary to learn. Then add the Russian to
`web/src/lib/i18n.ru.ts`. An unknown key passes through unchanged, so a
missing translation shows English rather than crashing — which also means
nothing will tell you that you forgot. Server-side strings are answered
in English and translated on the client by exact match, so rewording a
server message means updating the dictionary too.

**A new language.** Copy `i18n.ru.ts`, translate the values, add a plural
table if the language needs more forms than English, and wire it into
`i18n.ts`. That is the whole job — the design goal was one file per
language.

**A migration.** Next number, descriptive name, and a comment at the top
saying *why* the change is needed — the migration files are the closest
thing this project has to a schema changelog, and they read like one.
Then run the tests: `migrate.test.ts` applies every migration to an
in-memory database.

**A test.** See the section below — there is more machinery than there
used to be, and most of it exists so that the rules worth protecting can
be protected.

## Tests

```bash
npm test                      # both workspaces, what CI runs
npm test --workspace=server   # just one
```

Three kinds, in rough order of how often you will write them.

**Pure logic, next to the code.** `lib/*.test.ts` on both sides. Amount
parsing, recurrence arithmetic, plural forms, TOTP against the RFC
vectors. If the thing you are fixing can be reached by a function call,
this is where it goes, and it is the cheapest test in the repository.

**Through the API, without a socket.** `buildTestApp()` in
`server/src/test-harness.ts` gives you the real app, an in-memory
database with the migrations applied, and people to be:

```ts
const hub = await buildTestApp();
const alice = hub.join('alice');
const res = await hub.as(alice.cookie, 'POST', '/api/notes', { title: 'x' });
expect(res.statusCode).toBe(201);
```

This is how anything involving routes, guards or status codes is tested —
see `routes/guards.test.ts` and `routes/money-semantics.test.ts`.

One thing to know before you write your own setup: wrapping
`app.inject()` in `runWithDb` does **not** work. The request is
dispatched onto its own async chain and the `AsyncLocalStorage` context
does not follow it. The harness binds the database with an `onRequest`
hook instead, exactly the way demo mode binds a request to a visitor's
sandbox. Use the harness rather than rediscovering this.

**Whole-repository checks.** A couple of tests read the source rather
than call it: every `t()` key exists in the Russian dictionary, every
migration applies to an empty database. They catch the class of mistake
that no individual test would, because nothing is wrong at any one call
site.

### What deserves a test

Not everything. Something you fixed that could come back **silently**
does — a wrong sort order, an off-by-one in a date, an amount that has to
survive a round trip, a guard that could go missing. Visual things do
not: a colour, a spacing, a dark-theme contrast. Those are caught by
looking, and a test that asserts a class name is a test that breaks on
every redesign without ever catching a bug.

If you cannot write the test without extracting a function first,
extracting it is usually the right move. Both the TOTP replay fix and the
Devices ordering fix became testable exactly that way.

### Make it fail first

The most useful minute you can spend on a test is breaking the code it
guards and watching the right case go red. It is not a formality:

- a test can pass for the wrong reason and read as though it proved
  something;
- a test can assert on a field that some *other* layer happens to
  protect, which is what happened to the transaction-list case in
  `guards.test.ts` — it keyed on the note, and the note is masked
  independently of the guard being tested, so it passed with the guard
  removed. It keys on the id now.

Delete the guard, invert the condition, drop the `WHERE` clause — then
put it back. If nothing went red, the test is decoration.

## Reporting a bug

The issues in this repository are written a particular way, and following
it makes yours much faster to act on:

1. **What you did**, as numbered steps from a clean hub.
2. **What you expected**, and which rule or promise that comes from.
3. **What happened instead** — the actual output, not a paraphrase.
4. **The cause, if you found it** — `file.ts:line` and the reasoning.
   Optional, and enormously helpful.

Security issues are filed as ordinary public issues here, deliberately:
this is self-hosted software, people are running the current release, and
they deserve to know what it does and does not guarantee. State the
bounds honestly — what an attacker needs first, and how far it gets them.

## License

Contributions are made under [AGPL-3.0](LICENSE), the same license as the
project.

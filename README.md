# Neiliro

[![CI](https://img.shields.io/github/actions/workflow/status/neiliro/neiliro/ci.yml?branch=master&style=flat-square&labelColor=131c24)](https://github.com/neiliro/neiliro/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/neiliro/neiliro?style=flat-square&labelColor=131c24&color=1f6e8c)](https://github.com/neiliro/neiliro/releases)
[![Image](https://img.shields.io/badge/ghcr.io-neiliro-1f6e8c?style=flat-square&labelColor=131c24&logo=docker&logoColor=white)](https://github.com/neiliro/neiliro/pkgs/container/neiliro)
[![License](https://img.shields.io/github/license/neiliro/neiliro?style=flat-square&labelColor=131c24&color=1f6e8c)](LICENSE)
[![Stars](https://img.shields.io/github/stars/neiliro/neiliro?style=flat-square&labelColor=131c24&color=1f6e8c)](https://github.com/neiliro/neiliro/stargazers)

A self-hosted family hub: tasks, notes, calendar and money in one place. Built for a household, not a corporation: one Docker container, one SQLite file, no external services required. Runs on a home machine over the local network or on a cheap VPS with a real domain.

The core is complete and battle-tested by daily family use: accounts and sign-in (password and Google, with optional two-factor codes), projects and tasks with a kanban board, notes with attachments and wiki-links, a calendar with recurring events, a shared family mailbox that turns letters into tasks, full-text search, a home screen you arrange yourself out of widgets, and a money section — accounts with balances, expenses, income, transfers, bank reconciliation, categories, budgets, recurring transactions, receipts. It installs to the home screen as an app and keeps working read-only when the Wi-Fi does not.

## A quick look

![The Today board: the week's agenda, the month, the money — widgets each household arranges itself](docs/screenshots/dashboard.png)

<table>
  <tr>
    <td><img src="docs/screenshots/tasks.png" alt="Tasks: projects with a kanban board"></td>
    <td><img src="docs/screenshots/calendar.png" alt="Calendar: shared and personal, with recurring events"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/money.png" alt="Money: accounts, spending, budgets and recurring payments"></td>
    <td><img src="docs/screenshots/notes.png" alt="Notes: markdown with wiki-links and attachments"></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mail.png" alt="Mail: the shared household inbox, one click from letter to task"></td>
    <td><img src="docs/screenshots/settings.png" alt="Settings: sign-in, two-factor codes, devices and the colour palette"></td>
  </tr>
</table>

And on a phone, where it is installed to the home screen and the day starts with three one-tap actions:

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/phone-dashboard.png" alt="The phone dashboard: task, expense and note in one tap"></td>
    <td width="33%"><img src="docs/screenshots/phone-money.png" alt="Money on a phone: accounts stacked, the quick expense form below"></td>
    <td width="33%"><img src="docs/screenshots/phone-tasks.png" alt="Tasks on a phone"></td>
  </tr>
</table>

## Why not Notion / Google / Nextcloud?

The most common question in the feedback, in its three variants — answered honestly.

**Why not Notion or Obsidian?** Those are builders: a blank canvas and
blocks, and the family system is yours to design, maintain — and teach
to a spouse who never asked for a database course. Neiliro is the
opposite trade: an opinionated finished product. Tasks, notes, calendar
and money work a particular way out of the box, with the decisions
already made. If you enjoy building your own system, a builder will
genuinely serve you better; this is for families who want the thing,
not the constructor kit.

**Why not Google Keep + Calendar?** For lists and dates it is honestly
fine. The reason this project exists is money: shared accounts, budgets
with limits, recurring payments and bank reconciliation are the core
here, and no combination of Keep, Calendar and a spreadsheet does that
as one coherent thing. There is also a quieter argument: the family
archive — finances, receipts, private notes — lives in a SQLite file on
your own machine, not in an advertising company's cloud.

**Why not Nextcloud?** Closest in spirit — self-hosted, your data. But
Nextcloud is a platform: an app store, plugins with separate authors and
separate bugs, and real administration overhead. Neiliro is one small
app: one container, one database file, updates that take a minute.
Privacy is structural, not a setting — "private" is enforced
server-side per owner, and there is deliberately no admin backdoor to
read someone else's notes (see [architecture.md](docs/architecture.md)).

## Quick start

At home, with Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

The hub comes up on `http://localhost:8787` and is reachable from other devices on the network by the machine's address. An empty hub offers to create the first account right in the browser — that account becomes the administrator; family members join via single-use invitation links. Data lives **outside the project folder** (`~/.family-hub` or the mounted volume), so updating the code never touches it.

Tagged releases publish a prebuilt multi-arch image (amd64 + arm64, so Raspberry Pi works) to GitHub Container Registry — point `image:` in the compose file at it to skip building:

```bash
docker pull ghcr.io/neiliro/neiliro:latest   # or a pinned release: :1.1.0
```

For development:

```bash
npm install
npm run dev
```

Frontend on `http://localhost:5173`, API on `http://localhost:8787`. Vite listens on all interfaces, so tablets and phones on the same network can open `http://<machine-ip>:5173`.

## Documentation

- **[Deploying to a VPS](docs/deploy-vps.md)** — from a blank Ubuntu
  machine to `https://hub.example.com`: server hardening, launch,
  backups, Google sign-in, a public demo, auto-deploy from GitHub.
- **[Running on a home server](docs/home-server.md)** — HTTPS on the
  local network, the `.local` name and Bonjour, updating, backups,
  moving to another machine.
- **[Features](docs/features.md)** — the walkthrough: accounts and
  invitations, tasks, notes, calendar, search, and the money section
  with its semantics (reconciliation, budgets, recurring payments).
- **[Family mail](docs/family-mail.md)** — connecting the shared
  household mailbox: a dedicated account or a corner of a personal
  Gmail behind a label.
- **[Architecture](docs/architecture.md)** — the technical decisions:
  SQLite and migrations, local wall-clock time, money as integers,
  logging, how the demo sandboxes work.

## Demo mode

`DEMO_MODE=true` turns the hub into a public sandbox where every visitor
gets a private throwaway copy of a seeded sample family — one button to
enter, no password, self-cleaning. Details in
[architecture.md](docs/architecture.md); deployment next to a production
hub in [deploy-vps.md](docs/deploy-vps.md).

## Roadmap

The roadmap lives where you can see and influence it:

- **[Roadmap board](https://github.com/orgs/neiliro/projects/1)** —
  Now / Next / Later at a glance.
- **[Releases](https://github.com/neiliro/neiliro/releases)** —
  what landed and when.
- **[Issues](https://github.com/neiliro/neiliro/issues)** — vote
  with a 👍 on what you want most; that is genuinely how things get
  prioritized here.

Want to contribute? [CONTRIBUTING.md](CONTRIBUTING.md) covers running it
locally, the house conventions and the invariants worth knowing before
you touch the money or the privacy code. Start with a
[good first issue](https://github.com/neiliro/neiliro/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) —
they are written to be picked up cold.

Coming up next: CSV bank-statement import and shared shopping lists.

## License

[AGPL-3.0](LICENSE). Run it, change it, share it — but if you offer a
modified version to others as a service, its source must be open too.

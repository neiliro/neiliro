# ADR 0001 — Client-side encryption of what people write

**Status:** accepted 2026-09-04 · **Epic:** #208, sub-issues #209–#227

## Context

Neiliro has two faces from one codebase: self-hosted, where the family owns
the machine, and hosted (`*.neiliro.com`), where the operator does. Today
every family database is plain SQLite. Whoever can open the file — the
operator, a thief with the disk, anyone holding a backup — reads every note,
every meeting, every transaction comment. For a self-hoster that is the
deal they signed up for. For a hosted family it is not, and the operator
does not want that power either: a hub for a household's private life
should not depend on the hoster's manners.

The question this ADR answers is therefore not "should the data be
encrypted" but **what can honestly be closed, at what cost to the product,
and what promise follows from it.**

## Decision

**Encrypt the words, not the structure.** Every field a person reads as
text is encrypted in the browser with a key the server never holds. Every
field the server computes with — dates, amounts, foreign keys, statuses,
recurrence rules — stays in the clear. The server keeps doing what it does
today (balances, budgets, recurrence expansion, reconciliation) without
knowing what any of it is *about*.

Full zero-knowledge — the server sees only opaque blobs — was rejected. It
would move balances, budgets, recurrence and search into the client and
turn the hub into a local-first sync engine. That is a different product,
and months of rewrite for a team of one.

### What is encrypted

| Module | Encrypted | Stays in the clear | What it breaks |
|---|---|---|---|
| Notes | `title`, `body_md`, `note_versions`, `note_links.target_title`, attachments | folder, dates, owner, visibility | server-side search, wiki-link resolution by title |
| Tasks, projects | `title`, `description`, project names | status, due date, project id, owner | server-side search |
| Calendar | `title`, `description`, `location` | `starts_at`, `ends_at`, recurrence, calendar id, participants | the ICS feed and the single-event link |
| Money | `place`, `note`, category and account names, receipts | amounts, dates, currency, kind, every foreign key, budgets, reconciliations | nothing structural |
| Lists | item text, list and section names | order, checked state, caps | nothing |
| Profiles | `profile_entries.label` / `value` (allergies, preferences) | birthday, role | nothing |
| Wishlists | wish text — *decision pending*, see below | — | the public wishlist page |
| Mail | subject, body, `From`, attachments | arrival time, size, attachment count | the server sees the message once, on arrival |
| Attachments | the file itself | size, MIME type, what it belongs to | thumbnails, any server-side processing |

Rule for everything not in the table, and for every future feature: **the
server never processes text a person wrote.** A feature that needs to is a
feature that needs redesigning.

### Keys

This is the only part where a wrong answer looks right, so it is written
down in full.

- **One family key.** A random 256-bit key generated in the browser of the
  member who sets the hub up. It is shared by the whole family: members read
  the same notes, so they must hold the same key. Alongside it, an X25519
  key pair whose public half the server *does* hold — it lets the server
  seal incoming mail for the family without being able to open it.
- **Per-member envelopes.** The family key is stored on the server only
  wrapped: one envelope per member, locked with a key derived from that
  member's password. The server sees envelopes it cannot open.
- **The login changes.** Today the password travels to the server and is
  verified there with scrypt. If the same password also opens the envelope,
  the server knows enough at login time to open it. So the browser derives
  two independent keys from the password: an *auth key* that is sent in
  place of the password (and is itself scrypt-hashed server-side, as today),
  and a *wrap key* that never leaves the browser. Neither is derivable from
  the other. The user still types one password. Existing accounts migrate
  on their next successful login.
- **Invitations carry the key** in the URL fragment (`#…`), which browsers
  never send to the server. The invite link is already one-shot and expires
  in a week; it now literally is the key to the house, and the UI says so.
  The hosted founder invite (migration 030) is unaffected: the founder
  generates the key, nobody hands it to them.
- **Accounts without a password** (Google sign-in with `password_login_disabled`)
  have nothing to derive a wrap key from. They get a separate *data
  passphrase*, asked for once per device. The alternative — a device-held
  key with member re-admission as the only recovery — is on the table for
  the implementing issue.
- **Recovery is the family's, not ours.** `admin-reset` and the e-mail
  password reset restore *access*, not *data*: a new password cannot open
  the old envelope. Two doors remain, and both must exist before the first
  byte is encrypted:
  1. **Re-admission:** any member holding the key wraps a fresh envelope
     for the locked-out one, one click in Settings → Users.
  2. **Recovery code:** generated at setup, shown once, a third envelope
     locked with it. For a family of one this is the only door.
  Losing both means the words are gone for good. The setup screen says so
  in plain language and asks for an explicit acknowledgement, not a help
  page nobody reads.
- **Removing a member** does not re-encrypt history — they have already
  seen it. Whether to rotate the key for future writes is left to the
  implementing issue; the default is not to.
- **Key at rest in the browser.** Held as a non-extractable WebCrypto key
  in IndexedDB so a reload or a PWA relaunch does not demand the password
  again; an explicit "lock" clears it. XSS remains the residual risk, as it
  is for every web E2E client.

### What breaks, and the fix for each

- **Search.** FTS5 (migration 002) and `ci_contains` cannot index what they
  cannot read. Search moves to the client: it fetches the family's records
  once, decrypts, and searches locally. A family's data is thousands of
  rows, not millions. The server-side index is dropped once nothing reads it.
- **Wiki-links between notes** are keyed by title today. Resolution moves to
  the client, which is the only place that knows the titles.
- **Calendar feed and the single-event link.** Google Calendar polls a URL
  and expects plaintext ICS. The family key is embedded in the subscription
  token; the server decrypts on the fly for that request only. This fits the
  existing token-surface rules (unguessable, stored in the clear, read-only,
  one object, revocable with one button), and the person enabling it is
  handing those events to Google anyway.
- **Mail.** Mailgun (hosted) and the IMAP poller (self-hosted) deliver
  plaintext. `ingestEmail` seals subject, body, sender and attachments to the
  family's public key before anything is written. Plaintext lives for
  milliseconds in process memory and never reaches disk. This is disclosed,
  not hidden.
- **Attachments** are encrypted client-side before upload. The server stores
  ciphertext, knows size and declared type, and does nothing else with the
  file — there were no thumbnails to lose.
- **Export.** The archive from Settings currently contains the readable
  database. Two honest options: the browser decrypts and produces a readable
  export (the family's own copy), or the archive stays encrypted and the
  import script needs the recovery code. Both may be offered; neither may
  silently produce ciphertext the family cannot read later.
- **Demo.** The public sandbox is encrypted with a key embedded in the
  guest's session. One code path — a "plaintext mode" would be the path real
  data ends up on a year from now.
- **Self-hosted** gets the same code with no switch. For a self-hoster it is
  protection against a stolen laptop; for us it is the absence of a branch.
- **Wishlists** are the one public-by-design surface. Either wish text stays
  readable on the server (it is meant to be shown to guests), or the share
  link carries the key like the feed does. Decided in its own issue.

## What this protects against — and what it does not

**Closed.** The operator opening `sqlite3` out of curiosity or by mistake.
A stolen disk or snapshot. A leaked backup. A legal demand for stored data
(there is nothing readable to hand over). A server compromise that does not
extend to tampering with the served frontend.

**Still visible to anyone with the database.** Metadata, and a lot of it:
who is in the family and when they signed in, that an event exists and when,
every amount and date, which categories get spent on, how many notes live in
which folder, when mail arrives and how big it is, daily activity counters.
From this one can read a family's rhythm — 40 % on groceries, twelve events
a week, one every Tuesday at 19:00 — without reading a single word they
wrote. **We close the content, not the fact of its existence.**

**Not closed, and no web application can close it.** An operator who
decides to read *actively* can serve a modified bundle that exfiltrates the
key at the next login, and so can an attacker with lasting control of the
machine. This is the standing limitation of every browser-delivered E2E
client (Proton, Bitwarden's web vault, WhatsApp Web all share it). The
mitigations are external: public source, reproducible builds, published
bundle hashes and a short "how to verify" page. A native client shipped
through app stores would move that needle further; a web PWA cannot.

### The promise this licenses

Honest: *"The content of your notes, events, tasks and messages is encrypted
with a key we do not have. We cannot read it, and neither can anyone who
steals our disks or backups. The code is open."*

Dishonest, and not to be written anywhere: *"We cannot access your data."*
*"Zero knowledge."* *"We see nothing."*

## Rollout

1. **This document**, then the privacy policy and landing copy derived from
   it — the wording is settled before the code.
2. **Interim, for the beta:** encrypted disks, no ad-hoc database access on
   production outside logged runbook scripts, and a privacy policy that
   states plainly that the operator can technically read stored data today.
   Industry standard, and not something to be ashamed of; overpromising is.
3. **Key infrastructure:** family key, envelopes, the split login, invites
   carrying the key, re-admission, recovery code. Nothing is encrypted yet.
   This is the dangerous part — a mistake here is not fixable later — and it
   is built with tests on every invariant before any module touches it.
4. **Notes**, with client-side search. The most sensitive content, the
   fewest server dependencies.
5. **Calendar and tasks**, the feed with the key in the token.
6. **Money and lists.**
7. **Mail**, sealed on ingest.
8. **Verifiable frontend:** published hashes, reproducible build, the
   verification page.

## Rejected alternatives

- **Full zero-knowledge / local-first.** Right threat model, wrong product:
  it removes the server's ability to compute money, budgets and recurrence,
  and rebuilds the hub as a sync engine. Months, for one developer, on the
  eve of a beta.
- **Server-side encryption with a per-session passphrase** (the second
  option in #14). Simpler, but plaintext exists in server memory for every
  request; it protects a stolen disk and does not protect against the
  operator, which is the whole point of this decision.
- **Whole-database encryption at rest** (SQLCipher, LUKS). Kept as the
  interim step 2 — it protects the disk — but the process holds the key, so
  the operator still reads everything. It does not license any promise.
- **Encrypting only an opt-in "private section"** (#14 as originally
  scoped). A section where encryption is optional is a section where the one
  note that mattered ended up on the wrong side. Documents still get their
  own space later; the encryption is the hub's, not the section's.
- **A per-family passphrase separate from the login password.** Two
  secrets to remember, and the second one gets written on the fridge. Kept
  only for accounts that genuinely have no password.

## Related

- #14 — encrypted documents section: superseded in scope by this ADR, the
  feature itself remains.
- Migration 015 (mail account password stored readable) took the opposite
  decision deliberately, because the server must *use* that credential. The
  two decisions read as a pair: what the server needs to act on stays
  readable; what only people need to read does not.
- [architecture.md](../architecture.md) — search, time and money sections
  describe the server-side behaviour this ADR constrains.

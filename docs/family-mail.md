# Family mail: connecting a mailbox

The Mail section reads one shared mailbox over IMAP and sends replies
through its SMTP. Any provider works; below are the two setups that make
the most sense.

![The Mail section: a letter open, with the reply box and the button that turns it into a task](screenshots/mail.png)

## On a hosted hub: the address already exists

If the hub runs on a service (a `*.neiliro.com` subdomain rather than your
own machine), the family address is issued with the family — it is the
subdomain plus the mail domain, e.g. `smiths-a1b2@mail.neiliro.com`, and
**Settings → Family mailbox** shows it. Letters sent there appear in Mail
on their own; there is no IMAP to connect and no password to store.
Replies go out from that address.

Everything below is for a self-hosted hub — or for a hosted family that
would rather use a mailbox of its own, which takes over from the issued
address once connected.

## Option A: a dedicated mailbox (cleanest)

Create a mailbox that exists only for the household — either a fresh
Gmail account or a paid box on your own domain
([Migadu](https://migadu.com) is famously cheap for families). Then in
the hub: **Settings → Family mailbox**, fill in the address, IMAP/SMTP
hosts and the credentials, and press "Save and check" — the hub
immediately connects and fetches whatever is waiting.

For Gmail the hosts are `imap.gmail.com` / `smtp.gmail.com`, and the
password must be an **app password** (Google account → Security →
2-Step Verification → App passwords) — the regular account password does
not work for IMAP.

Give the address to the school, the utility company and the booking
sites — or add forwarding filters in your personal mail so their letters
land here.

## Option B: a corner of a personal mailbox

No new account needed. In your personal Gmail:

1. Create a label, e.g. `Neiliro`.
2. Create a filter: letters to `yourname+family@gmail.com` (or from
   chosen senders) → apply label `Neiliro`, skip the inbox.
3. In the hub settings, set **Folder to read** to `Neiliro`.

The hub reads only that folder — it never sees the personal inbox. The
`+family` alias behaves as the family address: hand it out, or forward
selected letters to it.

## Notes

- The password is stored on the server and is write-only in the UI: the
  settings screen never shows it back.
- The poller checks the folder every few minutes and marks fetched
  letters as read upstream; the "Synced …" line under the list shows
  the last successful pass, and sync errors surface at the top of the
  Mail section.
- Replies go out from the family address with the sender's name in
  front (`"Denis · family@… "`), so recipients answer the family box and
  the thread stays in the hub.
- The demo seeds sample letters instead of connecting anywhere; sending
  is disabled there.

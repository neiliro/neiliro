/*
  Which columns the browser encrypts (ADR 0001, phase 2).

  One table, one list. The codec (lib/codec.ts) seals these on the way out
  and opens them on the way in; everything not listed travels in the clear
  because the server computes with it — dates, amounts, ids, statuses.

  `field-map.test.ts` reads the migrations and insists that every TEXT
  column of a listed table is either here or in CLEAR_FIELDS with a reason:
  a new text column nobody thought about is a build failure, not a leak
  discovered a year later.
*/
export const ENCRYPTED_FIELDS: Record<string, readonly string[]> = {
  notes: ['title', 'body_md', 'excerpt'],
  // A version is the note's own ciphertext copied at snapshot time, bound to the note's id
  note_versions: ['title', 'body_md'],
  // Bound to the source note's id: one AAD per source, the link rows have no id of their own
  note_links: ['target_title'],
  // #217 — status, dates, priority and the tree stay clear: the board, the
  // calendar and the dashboard buckets are the server's queries
  tasks: ['title', 'description'],
  projects: ['title', 'description'],
  // #218 — times and the rule stay clear so the server keeps expanding
  // recurrence; a birthday event derived from a profile keeps the member's
  // name in plaintext, as the users table does
  events: ['title', 'description', 'location'],
  calendars: ['name'],
  // #219 — every amount, date, currency, kind and id stays clear: balances,
  // budgets and reconciliation are the server's arithmetic and never needed
  // a name. A reconciliation note is written and never read back; it is
  // bound to `<account_id>@<checked_on>`, the row's natural key.
  accounts: ['name'],
  categories: ['name'],
  transactions: ['note', 'place'],
  recurring_transactions: ['title', 'note', 'place'],
  reconciliations: ['note'],
  // #220 — order, checked state and sections stay clear; the caps count
  // rows, not characters. Wishes are NOT here: a wishlist is the family's
  // public face, meant for guests, and stays readable by decision.
  lists: ['title'],
  list_items: ['title'],
  list_sections: ['title'],
  // #221 — small, but medical. Birthday and role live in `profiles` and
  // stay clear: the dashboard's reminder needs the date.
  profile_entries: ['label', 'value'],
  // #222 — the file itself is a file envelope (lib/crypto/files.ts), tracked by
  // attachments.encryption; the filename is words
  attachments: ['filename'],
};

/** Text columns of the tables above that stay readable, and why. */
export const CLEAR_FIELDS: Record<string, Record<string, string>> = {
  notes: {
    id: 'identifier',
    folder_id: 'structure: the folder tree is kept by the server',
    visibility: 'privacy is enforced server-side on this value',
    owner_id: 'privacy is enforced server-side on this value',
    daily_date: 'a date, unique per day, looked up by the server',
    created_at: 'a timestamp',
    updated_at: 'a timestamp, the list is ordered by it',
  },
  note_versions: {
    id: 'identifier',
    note_id: 'identifier',
    author_id: 'identifier',
    created_at: 'a timestamp — the ten-minute snapshot rule needs it',
  },
  note_links: {
    source_note_id: 'identifier',
    target_note_id: 'identifier — resolved by the browser, joined by the server for backlinks',
  },
  tasks: {
    id: 'identifier',
    project_id: 'identifier',
    parent_id: 'identifier — the tree is the server’s',
    status: 'an enum the board and the buckets filter by',
    priority: 'an enum the dashboard orders by',
    due_date: 'a date — buckets, calendar window, recurrence',
    expected_date: 'a date — replaces the due date in the buckets',
    assignee_id: 'identifier',
    recurrence_rule: 'a machine rule (RRULE subset) the server expands',
    recurrence_parent_id: 'identifier — the series anchor',
    completed_at: 'a timestamp',
    created_by: 'identifier',
    created_at: 'a timestamp',
    updated_at: 'a timestamp',
  },
  projects: {
    id: 'identifier',
    color: 'a hex colour',
    icon: 'an emoji chosen from a fixed set, not written',
    archived_at: 'a timestamp',
    created_by: 'identifier',
    created_at: 'a timestamp',
    updated_at: 'a timestamp',
  },
  events: {
    id: 'identifier',
    calendar_id: 'identifier — visibility is enforced server-side through it',
    starts_at: 'a wall-clock time the server expands and windows by',
    ends_at: 'a wall-clock time',
    recurrence_rule: 'a machine rule (RRULE subset) the server expands',
    project_id: 'identifier',
    profile_user_id: 'identifier — marks the birthday event a profile derives',
    share_token: 'an unguessable token, stored in the clear by design (migration 027)',
    created_by: 'identifier',
    created_at: 'a timestamp',
    updated_at: 'a timestamp',
  },
  calendars: {
    id: 'identifier',
    color: 'a hex colour',
    owner_id: 'identifier — privacy is enforced server-side on this value',
  },
  accounts: {
    id: 'identifier',
    currency: 'an ISO code the totals group by',
    kind: 'an enum — the outlook excludes savings',
    owner_id: 'identifier — privacy is enforced server-side on this value',
    color: 'a hex colour',
    archived_at: 'a timestamp',
    created_by: 'identifier',
    created_at: 'a timestamp',
    updated_at: 'a timestamp',
  },
  categories: {
    id: 'identifier',
    kind: 'an enum — expense or income',
    color: 'a hex colour',
    archived_at: 'a timestamp',
    created_at: 'a timestamp',
    parent_id: 'identifier — the one-level tree the budget subquery walks',
  },
  transactions: {
    id: 'identifier',
    kind: 'an enum the balance arithmetic branches on',
    occurred_on: 'a date — periods, balances as of a day',
    account_id: 'identifier',
    to_account_id: 'identifier',
    category_id: 'identifier',
    created_by: 'identifier',
    created_at: 'a timestamp — same-day ordering for reconciliation',
    updated_at: 'a timestamp',
    recurring_id: 'identifier — the words of a rule-made transaction are read through it',
    recurring_on: 'a date — the series instance, for idempotency',
  },
  recurring_transactions: {
    id: 'identifier',
    kind: 'an enum',
    start_on: 'a date the series expands from',
    recurrence_rule: 'a machine rule (RRULE subset) the server expands',
    account_id: 'identifier',
    to_account_id: 'identifier',
    category_id: 'identifier',
    created_by: 'identifier',
    created_at: 'a timestamp — the list is ordered by it',
    updated_at: 'a timestamp',
  },
  reconciliations: {
    id: 'identifier',
    account_id: 'identifier',
    checked_on: 'a date the discrepancy is computed as of',
    created_by: 'identifier',
    created_at: 'a timestamp — same-day ordering against transactions',
  },
  lists: {
    id: 'identifier',
    created_by: 'identifier',
    created_at: 'a timestamp',
    share_token: 'an unguessable token, stored in the clear by design (migration 028)',
  },
  list_items: {
    id: 'identifier',
    list_id: 'identifier',
    checked_at: 'a timestamp — the checked pile is ordered by it',
    created_by: 'identifier',
    created_at: 'a timestamp',
    section_id: 'identifier',
  },
  list_sections: {
    id: 'identifier',
    list_id: 'identifier',
    created_at: 'a timestamp',
  },
  profile_entries: {
    id: 'identifier',
    user_id: 'identifier',
    kind: 'an enum — allergy or preference — the list filters by',
  },
  attachments: {
    id: 'identifier',
    mime: 'the declared type — tells an image from a document, decides inline serving',
    storage_path: 'a server-made path, never a human name (see storageNameFor)',
    note_id: 'identifier',
    transaction_id: 'identifier',
    mail_message_id: 'identifier',
    uploaded_by: 'identifier',
    created_at: 'a timestamp',
  },
};

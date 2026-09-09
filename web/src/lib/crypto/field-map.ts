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
};

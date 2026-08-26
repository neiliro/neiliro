-- Shared lists (#11) — the shopping list and its friends.
--
-- The most-requested thing in early feedback, and the request was never
-- "notes with checkboxes" (which already worked) but *speed*: one tap to
-- add, one tap to check, and a list that stays clean without tidying.
-- That is why this is its own pair of tables rather than a view over
-- tasks or notes. A task carries status, priority, due date, assignee and
-- recurrence — all meaningless for "milk" — and a note is one document,
-- so checking an item would rewrite the whole thing through the editor.
-- Here an add is one INSERT and a check is one UPDATE of one column.
--
-- Deliberately NO owner_id. Everything else private in this hub is
-- private per person; a shared list is the opposite by definition — the
-- point is that whoever is nearest the shop can see it. Privacy here
-- would make the feature pointless, so the absence is a decision, not an
-- omission.

CREATE TABLE lists (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  position    REAL NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE list_items (
  id          TEXT PRIMARY KEY,
  list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  -- Checked state is a timestamp, not a flag: "what did we buy today"
  -- is answerable, and the checked pile can be sorted by when it happened.
  checked_at  TEXT,
  position    REAL NOT NULL DEFAULT 0,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_list_items_list ON list_items(list_id, position);

-- One list to start with, so the feature is useful before anyone
-- configures anything. Fixed id, like the Inbox project and the Shared
-- calendar: the client translates the seeded name back for Russian
-- devices (listTitle helper) and a rename by the family survives.
INSERT INTO lists (id, title, position, created_at)
VALUES ('00000000-0000-4000-8000-000000000301', 'Shopping', 0, datetime('now'));

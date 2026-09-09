-- The family key and the doors to it (ADR 0001, #210).
--
-- The family key is generated in a browser and never reaches the server
-- in the clear. What the server stores is envelopes: the key wrapped
-- (AES-GCM, web/src/lib/crypto/envelope.ts, the `w1:` format) under a
-- key the server does not hold. One envelope per door:
--
--   password  — the member's own; opened by the wrap key the browser
--               derives from their password at sign-in (#211).
--   recovery  — the family's, user_id NULL; opened by the recovery code
--               shown once when the key was created. For a family of one
--               it is the only door after a lost password.
--   handoff   — a fresh envelope one member wraps for another under a
--               random secret that travels in a link's URL fragment
--               (never sent to the server). How a member locked out by a
--               password reset gets back in, and (#212) how an invited
--               member receives the key in the first place.
--
-- Envelopes are retired, not deleted: a password reset kills the
-- password envelope (the new password cannot open it), and the row with
-- retired_at is how the UI knows to offer the other two doors.
CREATE TABLE key_envelopes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('password', 'recovery', 'handoff')),
  envelope    TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  retired_at  TEXT,
  CHECK ((kind = 'recovery') = (user_id IS NULL))
);
CREATE INDEX idx_key_envelopes_user ON key_envelopes(user_id, kind, retired_at);

-- One row: the family has a key, and this is its X25519 public half. The
-- private half is derived from the family key in the browser and is never
-- stored anywhere; the public one lets the server seal incoming mail for
-- the family later (#223) without being able to open it. Its own table
-- rather than a settings row: /api/settings is writable by every member,
-- and a public key anyone can replace is a public key for anyone.
CREATE TABLE family_key (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

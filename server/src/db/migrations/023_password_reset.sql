-- Password reset by email — hosted only.
--
-- A self-hosted family owns the machine: the recovery door is ssh plus
-- scripts/admin-reset.mjs, which is stronger than any email flow and needs
-- no mail server. On the hosted service nobody has that door, so a
-- forgotten password would otherwise be a support ticket in Denis's DMs.
--
-- Same shape as invites (011): the token is stored hashed, because a
-- database leak must not hand out working resets. Two differences, both
-- deliberate — the lifetime is an hour rather than a week (a reset is
-- used immediately or not at all), and a new request invalidates the
-- previous one, so a mailbox never holds two working links.

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  -- Kept after use: "this password was changed by a reset, at this time"
  -- is worth being able to answer.
  used_at     TEXT
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

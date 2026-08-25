-- Verified login addresses — the ground the hosted password reset stands on.
--
-- The login has always been an address in shape only: nothing ever checked
-- that the person owns it, and self-hosted installs legitimately use
-- fictional ones (docs still show name@hub.local). That was harmless while
-- the address was only an identifier. It stopped being harmless when a
-- forgotten password could be recovered through it: a typo at signup would
-- hand a stranger a working reset link into someone else's family.
--
-- So a reset is only ever mailed to an address that answered a
-- confirmation. The token is stored hashed, like invites and resets, and it
-- remembers which address it was issued for — a confirmation must not
-- validate an address the account no longer uses.

ALTER TABLE users ADD COLUMN email_verified_at TEXT;

CREATE TABLE email_verifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The address this token proves. Compared on use: if the account has
  -- moved to another address since, the token is stale, not a shortcut.
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);

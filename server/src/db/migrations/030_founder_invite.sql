-- The founder invitation — first run behind a token, on the hosted service.
--
-- Provisioning used to print a bare URL, and the first person to open it
-- became the family's administrator. That is fine when the operator hands
-- the laptop over; it is not fine when the link travels by mail: a leaked
-- URL hands the family to whoever opened it, and the administrator ends
-- up with an address nobody proved — the only channel that can recover
-- their account (#157).
--
-- So the service now issues an invitation before any user exists: the
-- usual single-use invite, with role 'admin', mailed to the address the
-- family gave. Two things the original table could not hold: an invite
-- with no creator (created_by was NOT NULL — there is no user yet to be
-- one), and the address the invitation went to. That address is proven by
-- the act of receiving the link, so an account created with it starts
-- confirmed. SQLite cannot drop NOT NULL in place; the table is rebuilt.

CREATE TABLE invites_next (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'kid')),
  -- NULL only for the founder invitation, issued by the service itself
  created_by TEXT REFERENCES users(id),
  -- Where the invitation was mailed. An account created through the
  -- invite with this exact login is confirmed by construction.
  email      TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    TEXT REFERENCES users(id),
  used_at    TEXT
);

INSERT INTO invites_next (id, token_hash, role, created_by, created_at, expires_at, used_by, used_at)
  SELECT id, token_hash, role, created_by, created_at, expires_at, used_by, used_at FROM invites;

DROP TABLE invites;
ALTER TABLE invites_next RENAME TO invites;

-- Which secret password_hash is a hash of, and the salt the browser
-- stretches the password with (ADR 0001, #211).
--
-- Until now the browser sent the password and the server scrypt-hashed
-- it. From here on the browser stretches the password itself and sends a
-- derived *auth key*; the server hashes that. The other half of the same
-- derivation, the wrap key, never leaves the browser — it opens the
-- member's key envelope (#210), and the server must not be able to
-- reproduce it from anything it sees at login.
--
--   kdf_version NULL  password_hash = scrypt(password)   — an account from before
--   kdf_version 1     password_hash = scrypt(authKey v1) — derived in the browser
--
-- A legacy account migrates on its next successful sign-in: the browser
-- sends the password one last time together with the new auth key, the
-- server verifies the old hash and stores the new one. Nothing is
-- rewritten in bulk — the server cannot compute an auth key it never saw.
ALTER TABLE users ADD COLUMN kdf_version INTEGER;

-- The salt is random per account and public: the server hands it out
-- before sign-in (/api/auth/prelogin). Not the login address — an
-- administrator can change that, and a key bound to it would die with it.
-- Every existing account gets one now, so the browser can derive from the
-- first post-upgrade sign-in; new accounts bring their own.
ALTER TABLE users ADD COLUMN kdf_salt TEXT;
UPDATE users SET kdf_salt = lower(hex(randomblob(16)));

-- For an address with no account, prelogin answers a salt derived from
-- this secret and the address: stable, so asking twice tells nothing, and
-- indistinguishable from a real one, so neither does asking once.
INSERT INTO settings (key, value) VALUES ('kdf.decoy_secret', lower(hex(randomblob(32))));

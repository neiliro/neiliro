-- An invitation carries the family key (ADR 0001, #212).
--
-- The inviting browser wraps the family key under a fresh random secret
-- and stores the envelope with the invite; the secret travels only in the
-- fragment of the link (#k=…), which browsers never send to a server. The
-- invitee's browser opens the envelope with the fragment and holds the key
-- from its first sign-in. NULL for invites made before this, by a browser
-- that did not hold the key, and for the founder invitation (migration
-- 030) — the founder generates the key, nobody hands it to them.
ALTER TABLE invites ADD COLUMN envelope TEXT;

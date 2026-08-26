-- A public link for one event.
--
-- The third token-addressed surface, after the public wishlist (021) and
-- the calendar subscription (026): "the birthday party is on Saturday at
-- three, here is where" sent to people who have no account here and never
-- will. Without it the alternative is retyping the details into a
-- messenger, which is how details get retyped wrong.
--
-- Plaintext for the same reason as its siblings: the link is long-lived
-- and meant to be re-sent — to the second parent, to the group chat a week
-- later. Hashing it would make re-sharing impossible without revoking.
--
-- Note what a token does NOT grant: it addresses one event, never the
-- calendar it belongs to. The calendar's name can itself be private
-- ("Bob's therapy"), so the public view deliberately omits it, along with
-- participants and the linked project.
ALTER TABLE events ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_events_share_token ON events(share_token) WHERE share_token IS NOT NULL;

-- A public link for one list (#11 follow-up).
--
-- The fourth token-addressed surface, after the wishlist (021), the
-- calendar subscription (026) and a single event (027). The use case is
-- the one the shopping list was built for: hand the list to whoever is
-- going to the shop, including people with no account here.
--
-- Unlike the other three, a guest can *write* — but only one thing:
-- ticking an item off. That is the whole point of sending someone a
-- shopping list, and it is why this link is not simply read-only. A guest
-- still cannot add, rename, delete or see anything but this one list.
--
-- Plaintext, like its siblings: the link is meant to be re-sent.
ALTER TABLE lists ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_lists_share_token ON lists(share_token) WHERE share_token IS NOT NULL;

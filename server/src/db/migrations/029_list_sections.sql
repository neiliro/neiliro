-- Sections inside a list: "Vegetables", "Dairy", "Household".
--
-- Why sections and not more lists: several lists already exist and are the
-- right answer for separate errands ("Groceries" vs "Hardware"). Sections
-- answer the other case — one trip through one supermarket, read by aisle.
--
-- Depth is one level, like money's subcategories (012), and for the same
-- reason: a tree turns every render into recursion while a family gets by
-- with "group → line". An item belongs to a section or to nothing; a
-- section never belongs to a section.
--
-- Membership is optional, deliberately. #11 was about speed — typing an
-- item must never require choosing where it goes — so an item with no
-- section is normal, not unfiled: it simply sits above the sections.
--
-- Deleting a section does not delete its items (ON DELETE SET NULL): they
-- rise to the top of the list, exactly as subcategories rise to the top
-- level when their parent goes. The items are the point; the grouping is
-- a convenience.

CREATE TABLE list_sections (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_list_sections_list ON list_sections(list_id, position);

ALTER TABLE list_items ADD COLUMN section_id TEXT REFERENCES list_sections(id) ON DELETE SET NULL;
CREATE INDEX idx_list_items_section ON list_items(section_id);

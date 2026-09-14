-- search_index (002_search.sql) indexed notes/tasks/projects for the
-- server-side FTS5 lookup. Since client-side encryption (ADR 0001), the
-- title/body columns it indexes are ciphertext — trigram matching against
-- encrypted bytes can't find anything a person typed. Search moved to the
-- browser (/api/search/corpus + web/src/lib/search.ts, #226), which builds
-- its own index from decrypted data on the client. Nothing reads
-- search_index any more: drop the triggers that kept it in sync and the
-- table itself.
DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TRIGGER IF EXISTS tasks_ai;
DROP TRIGGER IF EXISTS tasks_ad;
DROP TRIGGER IF EXISTS tasks_au;
DROP TRIGGER IF EXISTS projects_ai;
DROP TRIGGER IF EXISTS projects_ad;
DROP TRIGGER IF EXISTS projects_au;

DROP TABLE IF EXISTS search_index;

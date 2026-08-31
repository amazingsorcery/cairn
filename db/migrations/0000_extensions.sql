-- Hand-written. docs/architecture/HANDOFF.md §6 and docs/architecture/search.md §7.1.
--
-- Trigram matching for the fuzzy search fallback (search.md §5). drizzle-kit never emits
-- CREATE EXTENSION, so this file exists and must run FIRST: 0002_search_and_ordering.sql
-- creates two gin_trgm_ops indexes, and gin_trgm_ops does not exist until pg_trgm does.
--
-- `drizzle-kit push` would drop this. It is forbidden in every environment (HANDOFF §6).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

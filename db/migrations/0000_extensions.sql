-- Hand-written: drizzle-kit never emits CREATE EXTENSION.
-- pg_trgm for the fuzzy search fallback. Must run before 0002, which uses gin_trgm_ops.
-- Don't use `drizzle-kit push`; it would drop this.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

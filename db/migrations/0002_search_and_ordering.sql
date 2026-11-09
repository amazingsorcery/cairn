-- Hand-written. Runs after 0001_schema.sql (tables) and 0000_extensions.sql (pg_trgm).
-- Objects drizzle-kit can't generate; `drizzle-kit push` would drop them.

-- 1. Fuzzy fallback indexes. Only name/title: the fallback is for "did you mean", not prose.
CREATE INDEX IF NOT EXISTS tools_name_trgm_idx
    ON tools USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS playbooks_title_trgm_idx
    ON playbooks USING gin (title gin_trgm_ops);
--> statement-breakpoint
-- 2. Deferrable uniqueness on step ordering, so swapping two steps doesn't transiently
--    violate it. DO block because ADD CONSTRAINT has no IF NOT EXISTS (re-runnable by hand).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'playbook_steps_playbook_order_uniq'
    ) THEN
        ALTER TABLE playbook_steps
            ADD CONSTRAINT playbook_steps_playbook_order_uniq
            UNIQUE (playbook_id, order_index)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END
$$;

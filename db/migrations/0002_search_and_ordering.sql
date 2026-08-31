-- Hand-written. docs/architecture/HANDOFF.md §6 and docs/architecture/search.md §7.1.
-- Runs AFTER the generated schema migration (0001_schema.sql), because it alters tables
-- that migration creates, and AFTER 0000_extensions.sql, which creates pg_trgm.
--
-- Three objects drizzle-kit cannot generate. `drizzle-kit push` would drop all three.

-- 1. Fuzzy fallback indexes (search.md §5). Only `name` / `title` are trigram-indexed:
--    the fallback exists to rescue "did you mean this tool", not to substring-search prose.
CREATE INDEX IF NOT EXISTS tools_name_trgm_idx
    ON tools USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS playbooks_title_trgm_idx
    ON playbooks USING gin (title gin_trgm_ops);
--> statement-breakpoint
-- 2. Deferrable uniqueness on step ordering. drizzle-kit cannot express DEFERRABLE.
--    Without INITIALLY DEFERRED, a drag-to-reorder that swaps two steps transiently
--    duplicates an order_index and aborts, forcing a shuffle through sentinel values.
--
--    ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS, so it is guarded by a DO block
--    to keep this file re-runnable by hand. The Drizzle journal already guarantees the
--    migration runs once; this guard is for the operator who runs the file directly.
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

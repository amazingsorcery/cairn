-- updated_at must be true however the row changed.
--
-- Drizzle maintains `updated_at` with `$onUpdate`, which is application-level. That is
-- correct for anything written through the app and silently wrong for anything written at a
-- console.
--
-- It matters here for one specific reason: `docs/frontend/HANDOFF-map.md` documents the
-- connector kill-switch as a psql `UPDATE`, and ADR 0012 made `enabled` a column precisely so
-- an operator can flip a source off under load without a deploy. So the most operationally
-- important write in this system is the one Drizzle never sees. After several kill-switch
-- flips during the build, `connectors.updated_at` still read seed time — meaning an operator
-- asking "when was this switched on, and is that recent?" gets an answer that is a month out
-- and looks authoritative.
--
-- A trigger makes the column true regardless of who wrote the row. It does not replace
-- `$onUpdate`; the two agree, and the trigger is the one that also covers `psql`, a migration,
-- and a restore.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    -- Only touch it when something actually changed. An UPDATE that sets a row to its own
    -- values should not move the timestamp, or "last changed" becomes "last written".
    IF NEW IS DISTINCT FROM OLD THEN
        NEW.updated_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every table carrying updated_at. Listed explicitly rather than discovered dynamically, so
-- adding a table is a deliberate line here rather than a silent inheritance.
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'users', 'categories', 'tags', 'tools', 'playbooks', 'playbook_steps',
        'workspaces', 'workspace_items', 'notes', 'reviews', 'connectors', 'cameras'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_updated_at', t);
            EXECUTE format(
                'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                t || '_set_updated_at', t
            );
        END IF;
    END LOOP;
END $$;

-- Maintain updated_at in the database too. Drizzle's `$onUpdate` only covers app writes;
-- this also covers psql updates (e.g. flipping the connector kill-switch), migrations and
-- restores.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    -- Skip no-op updates.
    IF NEW IS DISTINCT FROM OLD THEN
        NEW.updated_at = now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tables with updated_at, listed explicitly.
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

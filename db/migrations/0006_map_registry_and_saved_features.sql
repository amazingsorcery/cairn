-- Hand-written. Map schema.
--
-- No PostGIS and no `cached_features` table: nothing issues spatial predicates, and live
-- positions are deliberately not stored.
--
-- 1. `connectors.kind` widens to `SOURCE_KINDS` (lib/sources/types.ts), so sources and
--    connectors share one registry. `flights` stays as a deprecated alias for `aircraft`.
-- 2. `connectors.poll_mode`: `onDemand` or `worker` (one global poll for all viewports).
--    Defaults to `onDemand`.
-- 3. `workspace_items.kind` gains `mapFeature`.
-- 4. `workspace_feature_snapshots`: features a user explicitly saved to a workspace.

-- 1. -----------------------------------------------------------------------------------
-- Replaces the constraint created in 0001.
ALTER TABLE connectors
    DROP CONSTRAINT IF EXISTS connectors_kind_check;
--> statement-breakpoint
ALTER TABLE connectors
    ADD CONSTRAINT connectors_kind_check
    CHECK (kind in ('aircraft', 'vessels', 'cameras', 'earthquakes', 'wildfires', 'weather',
                    'satellites', 'disasters', 'publicSafety', 'radio', 'infrastructure',
                    'flights'));
--> statement-breakpoint

-- 2. -----------------------------------------------------------------------------------
ALTER TABLE connectors
    ADD COLUMN IF NOT EXISTS poll_mode text NOT NULL DEFAULT 'onDemand';
--> statement-breakpoint
ALTER TABLE connectors
    ADD CONSTRAINT connectors_poll_mode_check
    CHECK (poll_mode in ('onDemand', 'worker'));
--> statement-breakpoint

-- 3. -----------------------------------------------------------------------------------
ALTER TABLE workspace_items
    DROP CONSTRAINT IF EXISTS workspace_items_kind_check;
--> statement-breakpoint
ALTER TABLE workspace_items
    ADD CONSTRAINT workspace_items_kind_check
    CHECK (kind in ('tool', 'checklistStep', 'mapFeature'));
--> statement-breakpoint

-- 4. -----------------------------------------------------------------------------------
-- PK is the FK: one snapshot per workspace item.
-- Attribution and licence are copied in because the licences require credit and the
-- connector row may change or be deleted before export.
-- No updated_at: a snapshot is immutable.
CREATE TABLE IF NOT EXISTS workspace_feature_snapshots (
    workspace_item_id uuid PRIMARY KEY
        REFERENCES workspace_items (id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL
        REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id uuid NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,

    -- Text, not an FK: retiring a source must not delete a user's evidence.
    source_slug text NOT NULL,
    source_name text NOT NULL,
    source_kind text NOT NULL,

    -- SourceFeature.id. Used only to recognise a re-save within one workspace.
    feature_ref text NOT NULL,

    -- Not geometry: the only query is "features in this workspace".
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    altitude_metres double precision,

    -- When the upstream observed it, not when it was saved.
    observed_at timestamp with time zone NOT NULL,

    source_url text,
    attribution text NOT NULL,
    licence text NOT NULL,
    properties jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT workspace_feature_snapshots_source_kind_check
        CHECK (source_kind in ('aircraft', 'vessels', 'cameras', 'earthquakes', 'wildfires',
                               'weather', 'satellites', 'disasters', 'publicSafety', 'radio',
                               'infrastructure')),
    CONSTRAINT workspace_feature_snapshots_latitude_check
        CHECK (latitude between -90 and 90),
    CONSTRAINT workspace_feature_snapshots_longitude_check
        CHECK (longitude between -180 and 180),
    CONSTRAINT workspace_feature_snapshots_feature_ref_check
        CHECK (length(feature_ref) > 0),
    CONSTRAINT workspace_feature_snapshots_source_slug_check
        CHECK (length(source_slug) > 0),
    CONSTRAINT workspace_feature_snapshots_properties_check
        CHECK (jsonb_typeof(properties) = 'object')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS workspace_feature_snapshots_workspace_idx
    ON workspace_feature_snapshots (workspace_id, observed_at DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS workspace_feature_snapshots_user_id_idx
    ON workspace_feature_snapshots (user_id);
--> statement-breakpoint

-- One save per feature per workspace, so repeated saves can't build up a track.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_feature_snapshots_unique_idx
    ON workspace_feature_snapshots (workspace_id, source_slug, feature_ref);

-- No index leads with feature_ref or source_slug: that would make "every workspace that
-- saved this aircraft" a cheap cross-user query.

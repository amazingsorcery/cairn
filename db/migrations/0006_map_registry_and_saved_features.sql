-- Hand-written. v2 map schema. ADRs 0022, 0024, 0025.
--
-- Four changes, and one very large non-change.
--
-- THE NON-CHANGE: there is no `CREATE EXTENSION postgis` here and no `cached_features` table,
-- even though product-brief §5 lists PostGIS in the locked stack. ADR 0022 makes that case in
-- full. In one line: nothing in this product issues a spatial predicate, the live layers are
-- deliberately not durable (an aircraft position from six hours ago is not something we claim
-- to keep), and a `cached_features` table is the aircraft-position table the block comment in
-- `db/schema.ts` forbids on sight, wearing a different name. The live cache is Redis, keyed
-- per source, and it expires. Installing PostGIS would add an extension to maintain across
-- every future major-version upgrade, in exchange for a spatial index over rows nobody queries.
--
-- 1. `connectors.kind` widens to the eleven `SOURCE_KINDS` from `lib/sources/types.ts`.
--    ADR 0024: sources and connectors are one registry, not two. adsb.lol is currently in the
--    database as a connector AND in code as an adapter, with two TTLs that already disagree
--    (60s on the row, 30s in `lib/sources/adsb-lol.ts`) and a kill-switch that only governs
--    one of the two paths to it. That is the defect the merge fixes.
--
--    `flights` is KEPT in the vocabulary and no row is rewritten. It is deprecated and means
--    `aircraft`. Rewriting it here would break `db/seed.ts`, `lib/connectors/flights.ts` and
--    `app/(public)/live/page.tsx` in the same commit, none of which this migration's author
--    owns. The coordinated rename is migration 0007's job — see ADR 0024 §Consequences.
--
-- 2. `connectors.poll_mode` — `onDemand` (today) or `worker` (one global poll fans out to
--    every viewport). ADR 0021 identified this as the fix for the three-viewport aircraft
--    ceiling and deferred it; this column is the half of it that is data. It defaults to
--    `onDemand` so nothing changes behaviour by being migrated: a source is promoted when the
--    worker container actually exists and an operator says so.
--
-- 3. `workspace_items.kind` gains `mapFeature`.
--
-- 4. `workspace_feature_snapshots` — the one thing about the live layers that IS durable,
--    because a user asked for it. ADR 0025.

-- 1. -----------------------------------------------------------------------------------
-- Migration 0001 created this constraint and is applied, so it is replaced rather than edited.
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
-- The primary key IS the foreign key: exactly one snapshot per workspace item, enforced by
-- the shape rather than by a unique index someone can drop.
--
-- Every column that the feature panel and the Markdown/PDF export render is here, including
-- `attribution` and `licence`. That is not redundancy with `connectors`: ODbL, CC BY and the
-- TfL terms make the credit a condition of use, and the connector row this feature came from
-- may be edited or deleted long before the case file is exported. A saved feature carries the
-- credit it owes.
--
-- There is no `updated_at`. A record of what an upstream said at 14:32 has no correct edit;
-- the user's changing view of it belongs in `notes`.
CREATE TABLE IF NOT EXISTS workspace_feature_snapshots (
    workspace_item_id uuid PRIMARY KEY
        REFERENCES workspace_items (id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL
        REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id uuid NOT NULL
        REFERENCES users (id) ON DELETE CASCADE,

    -- Text, not an FK to connectors: retiring a source must not delete a user's evidence.
    -- Same reasoning as workspace_items.tool_id being ON DELETE SET NULL beside a kept title.
    source_slug text NOT NULL,
    source_name text NOT NULL,
    source_kind text NOT NULL,

    -- SourceFeature.id. Used only to recognise a re-save within one workspace.
    feature_ref text NOT NULL,

    -- double precision, not geometry. ADR 0022: the only query over this table is
    -- "the features in this workspace", and the map draws them from a list.
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    altitude_metres double precision,

    -- When the UPSTREAM observed it. Not when we cached it, not when the user clicked save.
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

-- A feature is saved into a workspace at most once. Re-saving reports "already saved" rather
-- than appending a second observation: a user accumulating positions for one aircraft is a
-- flight-track table assembled a click at a time, which is the thing the Live block comment
-- in db/schema.ts forbids, reached by a route that felt like a feature.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_feature_snapshots_unique_idx
    ON workspace_feature_snapshots (workspace_id, source_slug, feature_ref);

-- DELIBERATELY ABSENT: any index whose leading column is `feature_ref` or `source_slug`.
-- That would make "every workspace that saved this aircraft" a fast cross-user query, which
-- is the same surveillance affordance the missing index on connector_requests.actor_key
-- exists to remove. Every index here leads with a workspace or a user.

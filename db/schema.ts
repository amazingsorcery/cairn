/**
 * Database schema.
 *
 * Conventions:
 * - `uuid` primary keys with `gen_random_uuid()`, except where Auth.js dictates otherwise.
 * - Enums are `text` + a CHECK constraint; no Postgres ENUM types.
 * - Timestamps are `timestamptz` mapped to `Date`.
 * - snake_case columns, camelCase properties (Auth.js tables keep the adapter's names).
 * - Ownership-bearing rows carry `user_id`, so authorisation is a join.
 * - Hard deletes with cascade, except where a user's record must survive an editorial
 *   change: `on delete set null` plus a denormalised snapshot.
 * - No PostGIS and no `cached_features` table. Live data stays in memory; only features a
 *   user saves are persisted (`workspace_feature_snapshots`). Coordinates are
 *   `double precision` with range CHECKs.
 *
 * Not here (hand-written migrations, since drizzle-kit can't generate them): `pg_trgm`, the
 * two `gin_trgm_ops` indexes, and the DEFERRABLE unique on `playbook_steps`. Never run
 * `drizzle-kit push`; it would drop them.
 */

import { relations, sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/* ------------------------------------------------------------------ *
 * Shared column helpers
 * ------------------------------------------------------------------ */

/** Drizzle has no tsvector type; it's only used in raw SQL, so a string type suffices. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector'
  },
})

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/* ------------------------------------------------------------------ *
 * Enumerated value sets
 *
 * Canonical definitions for Zod schemas, CHECK constraints and UI label maps. Adding a value
 * means editing the array and adding a migration that replaces the CHECK.
 * ------------------------------------------------------------------ */

export const USER_ROLES = ['user', 'editor', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** Fixed by Auth.js (`AdapterAccountType`). Do not extend. */
export const ACCOUNT_TYPES = ['oauth', 'oidc', 'email', 'webauthn'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

/** Editorial publication state for `tools` and `playbooks`. */
export const PUBLICATION_STATUSES = ['draft', 'published'] as const
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number]

/**
 * Ordered by ascending cost and exposure. `freeWithRegistration` is its own tier because
 * registration gives the operator an identity and query log, which users need to filter on.
 * camelCase like the other closed vocabularies; must match `lib/content/schema.ts`.
 */
export const COST_MODELS = [
  'free',
  'freeWithRegistration',
  'freemium',
  'paid',
  'subscription',
  'enterprise',
] as const
export type CostModel = (typeof COST_MODELS)[number]

/** How sure we are about an entry. Labels live in the UI layer. */
export const CONFIDENCE_LEVELS = ['verified', 'high', 'medium', 'needsReview'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

export const DIFFICULTY_LEVELS = ['beginner', 'intermediate', 'advanced'] as const
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number]

export const WORKSPACE_STATUSES = ['active', 'completed', 'archived'] as const
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

/**
 * `tool`: saved directory entry. `checklistStep`: from a playbook step. Both keep an FK plus
 * a snapshotted `title`. `mapFeature`: a saved live feature, stored in full in
 * `workspace_feature_snapshots` since there is no row to point at.
 */
export const WORKSPACE_ITEM_KINDS = ['tool', 'checklistStep', 'mapFeature'] as const
export type WorkspaceItemKind = (typeof WORKSPACE_ITEM_KINDS)[number]

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * What a source's data is about. Duplicated from `lib/sources/types.ts` rather than
 * imported, because the CHECK constraint needs a migration to change; `db/schema.test.ts`
 * asserts they match.
 */
export const SOURCE_KINDS = [
  'aircraft',
  'vessels',
  'cameras',
  'earthquakes',
  'wildfires',
  'weather',
  'satellites',
  'disasters',
  'publicSafety',
  'radio',
  'infrastructure',
] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/**
 * Connectors and map sources share one registry (legal basis, attribution, TTL, quotas,
 * kill-switch).
 *
 * `flights` is a deprecated alias for `aircraft`, kept for existing rows and code. Don't
 * write it to new rows.
 */
export const CONNECTOR_KINDS = [...SOURCE_KINDS, 'flights'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/**
 * How a source is polled.
 *   `onDemand`: fetched in the request path and cached; traffic follows readers.
 *   `worker`:   polled once globally on `cacheTtlSeconds`; viewports filter that payload.
 *
 * Under `worker`, `globalCeiling` limits the worker alone and `perUserQuota` only limits our
 * own API. Defaults to `onDemand`.
 */
export const POLL_MODES = ['onDemand', 'worker'] as const
export type PollMode = (typeof POLL_MODES)[number]

/**
 * Outcome of one outbound call. Refusals (`quotaDenied`, `rateLimited`, `disabled`) are
 * recorded even though no request was made.
 *
 * Keep `quotaDenied` (we refused the caller) separate from `rateLimited` (upstream 429/420,
 * or our cooldown after one); they point at different fixes.
 */
export const CONNECTOR_REQUEST_OUTCOMES = [
  'ok',
  'upstreamError',
  'quotaDenied',
  'rateLimited',
  'disabled',
  'timeout',
] as const
export type ConnectorRequestOutcome = (typeof CONNECTOR_REQUEST_OUTCOMES)[number]

/** What a camera looks at. */
export const CAMERA_VIEW_KINDS = ['traffic', 'transport', 'tourism'] as const
export type CameraViewKind = (typeof CAMERA_VIEW_KINDS)[number]

/** Renders the body of a CHECK constraint from an enum vocabulary. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`)

/* ================================================================== *
 * Auth.js v5 — @auth/drizzle-adapter tables
 *
 * Property names are read directly by the adapter (`emailVerified`, `providerAccountId`,
 * `refresh_token`); don't rename them. Column names are ours.
 * No `authenticators` table: only magic link and GitHub OAuth are supported.
 * ================================================================== */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    email: text('email').unique('users_email_key'),
    emailVerified: timestamptz('email_verified'),
    image: text('image'),
    /** Gates the admin content-editing path. `editor` may edit, `admin` may also publish. */
    role: text('role', { enum: USER_ROLES }).notNull().default('user'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  () => [check('users_role_check', oneOf('role', USER_ROLES))],
)

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    primaryKey({ name: 'accounts_pkey', columns: [t.provider, t.providerAccountId] }),
    index('accounts_user_id_idx').on(t.userId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamptz('expires').notNull(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    /** Supports the expired-session sweep run by the maintenance job. */
    index('sessions_expires_idx').on(t.expires),
  ],
)

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamptz('expires').notNull(),
  },
  (t) => [
    primaryKey({ name: 'verification_tokens_pkey', columns: [t.identifier, t.token] }),
    index('verification_tokens_expires_idx').on(t.expires),
  ],
)

/* ================================================================== *
 * Taxonomy
 * ================================================================== */

/** One flat taxonomy of investigative domains, shared by tools and playbooks. */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('categories_slug_key'),
    name: text('name').notNull(),
    /** One paragraph, Markdown. Rendered at the top of the category page. */
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('categories_sort_order_idx').on(t.sortOrder, t.name)],
)

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('tags_slug_key'),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('tags_name_idx').on(t.name)],
)

/* ================================================================== *
 * Directory
 * ================================================================== */

export const tools = pgTable(
  'tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('tools_slug_key'),
    name: text('name').notNull(),
    /** Canonical homepage or documentation URL. Never a referral or tracking link. */
    url: text('url').notNull(),
    /** One sentence, plain text, no Markdown. Used in cards, meta description and search. */
    summary: text('summary').notNull(),
    /** Long form, Markdown. Rendered on the tool detail page. */
    description: text('description').notNull(),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),

    /** Open vocabularies validated in Zod, not CHECKed, so new values need no migration. */
    inputTypes: text('input_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    outputTypes: text('output_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    costModel: text('cost_model', { enum: COST_MODELS }).notNull(),
    /** Free text. Where a price is stated it must be quoted from the vendor's own page. */
    costNotes: text('cost_notes'),

    /** Where the tool or its underlying data sits. Free text. */
    jurisdiction: text('jurisdiction'),
    /** What that jurisdiction implies for a user of this tool. Markdown. */
    legalNotes: text('legal_notes'),

    /** When a human last confirmed this entry against the primary source. Never back-dated. */
    lastVerifiedAt: timestamptz('last_verified_at'),
    /** Editorially assigned, 1–5. Not a user aggregate; see `reviews`. */
    reliability: integer('reliability'),
    reliabilityNotes: text('reliability_notes'),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull().default('needsReview'),

    status: text('status', { enum: PUBLICATION_STATUSES }).notNull().default('draft'),
    /** First transition to `published`. Drives the "recently added" ordering. */
    publishedAt: timestamptz('published_at'),

    /**
     * Category, tag, input and output names flattened to text on write. Needed because
     * generated columns require IMMUTABLE functions and `array_to_string` is STABLE.
     */
    searchKeywords: text('search_keywords').notNull().default(''),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(name, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(search_keywords, '')), 'C') || setweight(to_tsvector('english', coalesce(description, '')), 'D')`,
    ),

    /** Last editor. `set null` because deleting a staff account must not delete content. */
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('tools_search_vector_idx').using('gin', t.searchVector),
    index('tools_input_types_idx').using('gin', t.inputTypes),
    index('tools_output_types_idx').using('gin', t.outputTypes),
    index('tools_status_name_idx').on(t.status, t.name),
    index('tools_status_category_idx').on(t.status, t.categoryId, t.name),
    index('tools_status_published_at_idx').on(t.status, t.publishedAt.desc()),
    index('tools_status_reliability_idx').on(t.status, t.reliability.desc().nullsLast()),
    index('tools_status_cost_model_idx').on(t.status, t.costModel),
    /** Editorial staleness queue: least recently verified first, never-verified first. */
    index('tools_confidence_verified_idx').on(t.confidence, t.lastVerifiedAt.asc().nullsFirst()),
    index('tools_updated_by_id_idx').on(t.updatedById),

    check('tools_status_check', oneOf('status', PUBLICATION_STATUSES)),
    check('tools_cost_model_check', oneOf('cost_model', COST_MODELS)),
    check('tools_confidence_check', oneOf('confidence', CONFIDENCE_LEVELS)),
    check('tools_reliability_range_check', sql`reliability is null or reliability between 1 and 5`),
    /** Published tools must have a verification date and reliability rating. */
    check(
      'tools_published_requires_verification_check',
      sql`status <> 'published' or (last_verified_at is not null and reliability is not null)`,
    ),
  ],
)

export const toolTags = pgTable(
  'tool_tags',
  {
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'tool_tags_pkey', columns: [t.toolId, t.tagId] }),
    /** Reverse lookup for /tags/[slug]. The PK only serves tool -> tags. */
    index('tool_tags_tag_id_idx').on(t.tagId),
  ],
)

/* ================================================================== *
 * Playbooks
 * ================================================================== */

export const playbooks = pgTable(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('playbooks_slug_key'),
    title: text('title').notNull(),
    /** One sentence, plain text. Card copy and meta description. */
    summary: text('summary').notNull(),
    /** Markdown lead-in shown above the step list: scope, prerequisites, caveats. */
    overview: text('overview'),

    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    difficulty: text('difficulty', { enum: DIFFICULTY_LEVELS }).notNull(),
    /** Estimated duration in whole minutes. Formatted by the UI, never stored pre-formatted. */
    estimatedMinutes: integer('estimated_minutes').notNull(),

    /** Same accuracy metadata as tools. */
    lastVerifiedAt: timestamptz('last_verified_at'),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull().default('needsReview'),

    status: text('status', { enum: PUBLICATION_STATUSES }).notNull().default('draft'),
    publishedAt: timestamptz('published_at'),

    /** Category name, step titles and step objectives, flattened on write. See tools.searchKeywords. */
    searchKeywords: text('search_keywords').notNull().default(''),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(search_keywords, '')), 'C') || setweight(to_tsvector('english', coalesce(overview, '')), 'D')`,
    ),

    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('playbooks_search_vector_idx').using('gin', t.searchVector),
    index('playbooks_status_title_idx').on(t.status, t.title),
    index('playbooks_status_category_idx').on(t.status, t.categoryId, t.title),
    index('playbooks_status_difficulty_idx').on(t.status, t.difficulty, t.title),
    index('playbooks_status_published_at_idx').on(t.status, t.publishedAt.desc()),
    index('playbooks_confidence_verified_idx').on(
      t.confidence,
      t.lastVerifiedAt.asc().nullsFirst(),
    ),
    index('playbooks_updated_by_id_idx').on(t.updatedById),

    check('playbooks_status_check', oneOf('status', PUBLICATION_STATUSES)),
    check('playbooks_difficulty_check', oneOf('difficulty', DIFFICULTY_LEVELS)),
    check('playbooks_confidence_check', oneOf('confidence', CONFIDENCE_LEVELS)),
    check('playbooks_estimated_minutes_check', sql`estimated_minutes > 0`),
    check(
      'playbooks_published_requires_verification_check',
      sql`status <> 'published' or last_verified_at is not null`,
    ),
  ],
)

export const playbookSteps = pgTable(
  'playbook_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),
    /** 0-based position within the playbook. Contiguity is an application invariant. */
    orderIndex: integer('order_index').notNull(),
    title: text('title').notNull(),
    /** What this step is for, one sentence. */
    objective: text('objective').notNull(),
    /** How to do it. Markdown. */
    body: text('body').notNull(),
    /** How you know the step is done. */
    doneWhen: text('done_when').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * Ordering only. Uniqueness is a DEFERRABLE constraint in a hand-written migration
     * (drizzle-kit can't express it), so reorders can run in one transaction.
     */
    index('playbook_steps_playbook_order_idx').on(t.playbookId, t.orderIndex),
    check('playbook_steps_order_index_check', sql`order_index >= 0`),
  ],
)

export const playbookStepTools = pgTable(
  'playbook_step_tools',
  {
    stepId: uuid('step_id')
      .notNull()
      .references(() => playbookSteps.id, { onDelete: 'cascade' }),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    /** Why *this* tool at *this* step. Optional, plain text, one or two sentences. */
    note: text('note'),
    orderIndex: integer('order_index').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'playbook_step_tools_pkey', columns: [t.stepId, t.toolId] }),
    /** "Playbooks that use this tool" on the tool detail page. */
    index('playbook_step_tools_tool_id_idx').on(t.toolId),
    index('playbook_step_tools_step_order_idx').on(t.stepId, t.orderIndex),
  ],
)

/* ================================================================== *
 * Workspaces: the user's own case file
 *
 * The user's saved links, checklist state and notes. No records about investigation subjects.
 * ================================================================== */

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Optional provenance. `set null` so deleting a playbook never destroys a case file. */
    playbookId: uuid('playbook_id').references(() => playbooks.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    status: text('status', { enum: WORKSPACE_STATUSES }).notNull().default('active'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('workspaces_user_updated_idx').on(t.userId, t.updatedAt.desc()),
    index('workspaces_user_status_idx').on(t.userId, t.status, t.updatedAt.desc()),
    index('workspaces_playbook_id_idx').on(t.playbookId),
    check('workspaces_status_check', oneOf('status', WORKSPACE_STATUSES)),
  ],
)

export const workspaceItems = pgTable(
  'workspace_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Denormalised from `workspaces.user_id` so ownership is checkable without a join. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: WORKSPACE_ITEM_KINDS }).notNull(),

    /** Populated when kind = 'tool'. `set null` — see `title`. */
    toolId: uuid('tool_id').references(() => tools.id, { onDelete: 'set null' }),
    /** Populated when kind = 'checklistStep'. `set null` — see `title`. */
    stepId: uuid('step_id').references(() => playbookSteps.id, { onDelete: 'set null' }),

    /** Tool name or step title at save time, so editorial changes don't alter the checklist. */
    title: text('title').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    checked: boolean('checked').notNull().default(false),
    checkedAt: timestamptz('checked_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('workspace_items_workspace_order_idx').on(t.workspaceId, t.kind, t.orderIndex),
    index('workspace_items_user_id_idx').on(t.userId),
    index('workspace_items_tool_id_idx').on(t.toolId),
    index('workspace_items_step_id_idx').on(t.stepId),
    /** A tool is saved into a workspace at most once. */
    uniqueIndex('workspace_items_tool_unique_idx')
      .on(t.workspaceId, t.toolId)
      .where(sql`kind = 'tool' and tool_id is not null`),
    /** A playbook step yields at most one checklist entry per workspace. */
    uniqueIndex('workspace_items_step_unique_idx')
      .on(t.workspaceId, t.stepId)
      .where(sql`kind = 'checklistStep' and step_id is not null`),
    check('workspace_items_kind_check', oneOf('kind', WORKSPACE_ITEM_KINDS)),
    check('workspace_items_order_index_check', sql`order_index >= 0`),
    /*
     * No CHECK tying `kind` to a non-null tool_id/step_id: ON DELETE SET NULL would then
     * fail the CHECK and block editorial deletes. Enforced in Zod instead.
     */
  ],
)

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Denormalised owner, as on `workspace_items`. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Optional anchor to a saved tool or checklist entry. `set null` keeps the note. */
    workspaceItemId: uuid('workspace_item_id').references(() => workspaceItems.id, {
      onDelete: 'set null',
    }),
    /** Optional anchor to a playbook step the note was written against. */
    playbookStepId: uuid('playbook_step_id').references(() => playbookSteps.id, {
      onDelete: 'set null',
    }),
    /** The user's own prose. Markdown. Never parsed for entities, never indexed for search. */
    body: text('body').notNull(),
    /** The "timestamped" in "timestamped notes". Set once, never rewritten on edit. */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('notes_workspace_created_idx').on(t.workspaceId, t.createdAt.desc()),
    index('notes_user_id_idx').on(t.userId),
    index('notes_workspace_item_id_idx').on(t.workspaceItemId),
    index('notes_playbook_step_id_idx').on(t.playbookStepId),
  ],
)

/**
 * A live map feature as it was when a user saved it into a case file. The only persisted
 * live data, written only on an explicit save; cascades from `users`.
 *
 * - Complete and immutable: there's no row to point at, so everything the export renders
 *   (including attribution and licence) is copied in. No `updatedAt`.
 * - One save per feature per workspace, so repeated saves can't build a track.
 * - `featureRef` is never indexed on its own, so "every workspace that saved this aircraft"
 *   isn't a cheap cross-user query.
 */
export const workspaceFeatureSnapshots = pgTable(
  'workspace_feature_snapshots',
  {
    /** PK and FK: one snapshot per `mapFeature` item. */
    workspaceItemId: uuid('workspace_item_id')
      .primaryKey()
      .references(() => workspaceItems.id, { onDelete: 'cascade' }),
    /** Denormalised, as on `workspace_items` and `notes`, so ownership is not a join. */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** `SourceAdapter.slug`. Not an FK, so retiring a source doesn't delete saved evidence. */
    sourceSlug: text('source_slug').notNull(),
    /** The source's display name at save time, so the export reads correctly without a join. */
    sourceName: text('source_name').notNull(),
    sourceKind: text('source_kind', { enum: SOURCE_KINDS }).notNull(),

    /** `SourceFeature.id`. Only used to detect a re-save within a workspace. */
    featureRef: text('feature_ref').notNull(),

    /** Plain double precision; no spatial queries are needed. */
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    /** Metres, where the source published it. */
    altitudeMetres: doublePrecision('altitude_metres'),

    /** When the upstream observed this, not when it was saved. */
    observedAt: timestamptz('observed_at').notNull(),

    /** Where a reader gets back to the origin, when the source publishes a per-feature URL. */
    sourceUrl: text('source_url'),

    /** Credit captured at save time. Required: ODbL, CC BY and TfL terms mandate it. */
    attribution: text('attribution').notNull(),
    licence: text('licence').notNull(),

    /** `SourceFeature.properties`; shape varies per source. CHECKed to be an object. */
    properties: jsonb('properties').notNull().default({}),

    /** Set once; no `updatedAt`. */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('workspace_feature_snapshots_workspace_idx').on(t.workspaceId, t.observedAt.desc()),
    index('workspace_feature_snapshots_user_id_idx').on(t.userId),
    /** A feature is saved into a workspace at most once. */
    uniqueIndex('workspace_feature_snapshots_unique_idx').on(
      t.workspaceId,
      t.sourceSlug,
      t.featureRef,
    ),

    check('workspace_feature_snapshots_source_kind_check', oneOf('source_kind', SOURCE_KINDS)),
    check('workspace_feature_snapshots_latitude_check', sql`latitude between -90 and 90`),
    check('workspace_feature_snapshots_longitude_check', sql`longitude between -180 and 180`),
    check('workspace_feature_snapshots_feature_ref_check', sql`length(feature_ref) > 0`),
    check('workspace_feature_snapshots_source_slug_check', sql`length(source_slug) > 0`),
    /** A bare scalar or array here would break every reader of `properties`. */
    check('workspace_feature_snapshots_properties_check', sql`jsonb_typeof(properties) = 'object'`),
  ],
)

/* ================================================================== *
 * Reviews: modelled but not exposed yet.
 * ================================================================== */

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    body: text('body'),
    status: text('status', { enum: REVIEW_STATUSES }).notNull().default('pending'),
    moderatedById: uuid('moderated_by_id').references(() => users.id, { onDelete: 'set null' }),
    moderatedAt: timestamptz('moderated_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('reviews_tool_user_unique_idx').on(t.toolId, t.userId),
    index('reviews_tool_status_idx').on(t.toolId, t.status),
    /** Moderation queue: oldest pending first. */
    index('reviews_status_created_idx').on(t.status, t.createdAt),
    check('reviews_status_check', oneOf('status', REVIEW_STATUSES)),
    check('reviews_rating_range_check', sql`rating between 1 and 5`),
  ],
)

/* ================================================================== *
 * Live connectors
 *
 * Never add to this subtree:
 *   - tables of aircraft positions, tracks, callsigns, registrations or flight history;
 *   - camera imagery of any kind, including caches (we'd become a redistributor);
 *   - columns on `connector_requests` recording what was asked for (path, query, bbox,
 *     camera id, response body);
 *   - raw actor identifiers (see `connectorRequests.actorKey`);
 *   - any durable store of live map features. The live cache is in memory and expires.
 * ================================================================== */

/**
 * One row per upstream we may call: legal basis, attribution, quotas, freshness and
 * kill-switch.
 *
 *   - `status`:  editorial (draft/published).
 *   - `enabled`: operational kill-switch. Defaults to false so new connectors are inert.
 */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('connectors_slug_key'),
    name: text('name').notNull(),
    kind: text('kind', { enum: CONNECTOR_KINDS }).notNull(),

    /** The organisation that publishes the data, e.g. the transport authority or network. */
    operatorName: text('operator_name').notNull(),
    homepageUrl: text('homepage_url').notNull(),
    /** URL of the licence or terms of service that permit our use. Required to publish. */
    termsUrl: text('terms_url'),
    /** Attribution to render with the data. Null only when `attributionRequired` is false. */
    attribution: text('attribution'),
    attributionRequired: boolean('attribution_required').notNull().default(true),
    /** Why we are permitted to do this, in prose, citing the clause. Required to publish. */
    legalBasis: text('legal_basis'),

    baseUrl: text('base_url').notNull(),
    requiresApiKey: boolean('requires_api_key').notNull().default(false),
    /**
     * Name of the env var holding the key, never the key. CHECKed against
     * `^[A-Z][A-Z0-9_]*$` so a pasted secret is rejected.
     */
    apiKeyEnvVar: text('api_key_env_var'),

    /** Requests per `windowSeconds`, per user. Enforced through `rate_limits`. */
    perUserQuota: integer('per_user_quota').notNull(),
    /** Requests per `windowSeconds` across all users, so we cannot breach upstream fair use. */
    globalCeiling: integer('global_ceiling').notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),

    /** How long a fetched payload is served as fresh. */
    cacheTtlSeconds: integer('cache_ttl_seconds').notNull(),
    /** How long past the TTL we keep serving, labelled stale, before the degraded state. */
    staleWhileRevalidateSeconds: integer('stale_while_revalidate_seconds').notNull(),

    /** See `POLL_MODES`. */
    pollMode: text('poll_mode', { enum: POLL_MODES }).notNull().default('onDemand'),

    /** The operator kill-switch. False means: make no outbound call, serve the degraded state. */
    enabled: boolean('enabled').notNull().default(false),
    status: text('status', { enum: PUBLICATION_STATUSES }).notNull().default('draft'),
    /** When a human last confirmed the endpoint works and the terms are unchanged. */
    lastCheckedAt: timestamptz('last_checked_at'),
    notes: text('notes'),

    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /** Live connectors for a surface: the only hot read. */
    index('connectors_kind_status_enabled_idx').on(t.kind, t.status, t.enabled),
    index('connectors_updated_by_id_idx').on(t.updatedById),

    check('connectors_kind_check', oneOf('kind', CONNECTOR_KINDS)),
    check('connectors_status_check', oneOf('status', PUBLICATION_STATUSES)),
    check('connectors_poll_mode_check', oneOf('poll_mode', POLL_MODES)),
    /** Publishing requires terms URL, legal basis and a check date. */
    check(
      'connectors_published_requires_legal_basis_check',
      sql`status <> 'published' or (terms_url is not null and legal_basis is not null and last_checked_at is not null)`,
    ),
    /** If attribution is owed, the string must be present. */
    check(
      'connectors_attribution_check',
      sql`attribution_required = false or attribution is not null`,
    ),
    /** A connector that needs a key must name the env var that holds it. */
    check(
      'connectors_api_key_env_var_check',
      sql`(requires_api_key = false or api_key_env_var is not null) and (api_key_env_var is null or api_key_env_var ~ '^[A-Z][A-Z0-9_]*$')`,
    ),
    check(
      'connectors_quota_check',
      sql`per_user_quota > 0 and global_ceiling >= per_user_quota and window_seconds > 0 and timeout_ms > 0`,
    ),
    check(
      'connectors_cache_check',
      sql`cache_ttl_seconds >= 0 and stale_while_revalidate_seconds >= 0`,
    ),
  ],
)

/**
 * Outbound audit log. Answers operational questions (failures, denials, latency) but not
 * "who looked at what": no request content, and the actor is a keyed hash.
 */
export const connectorRequests = pgTable(
  'connector_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    requestedAt: timestamptz('requested_at').notNull().defaultNow(),
    outcome: text('outcome', { enum: CONNECTOR_REQUEST_OUTCOMES }).notNull(),
    /** Wall-clock cost of the attempt. 0 for `quotaDenied` and `disabled`. */
    durationMs: integer('duration_ms').notNull(),
    /** Upstream HTTP status. Null when no request was made, or when it timed out. */
    upstreamStatus: integer('upstream_status'),
    /**
     * Outbound HTTP requests made by this attempt (DNS queries six record types, RIPEstat
     * four endpoints). Volume only, like `duration_ms`. 0 when nothing was sent; default 1.
     */
    upstreamRequests: integer('upstream_requests').notNull().default(1),
    /**
     * `HMAC-SHA256(userId or client IP, RATE_LIMIT_SECRET)`, lowercase hex. The CHECK
     * (64 hex chars) rejects raw uuids, emails and IPs.
     */
    actorKey: text('actor_key').notNull(),
    /** Retention horizon; rows are swept, not archived. */
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [
    /** Per-connector health over a time window. */
    index('connector_requests_connector_time_idx').on(t.connectorId, t.requestedAt.desc()),
    index('connector_requests_outcome_time_idx').on(t.outcome, t.requestedAt.desc()),
    index('connector_requests_expires_at_idx').on(t.expiresAt),
    /*
     * No index on `actor_key`, so "everything this actor did" isn't a cheap query. Quotas
     * use `rate_limits` instead.
     */
    check('connector_requests_outcome_check', oneOf('outcome', CONNECTOR_REQUEST_OUTCOMES)),
    check('connector_requests_duration_check', sql`duration_ms >= 0`),
    check('connector_requests_upstream_requests_check', sql`upstream_requests >= 0`),
    check(
      'connector_requests_upstream_status_check',
      sql`upstream_status is null or upstream_status between 100 and 599`,
    ),
    check('connector_requests_actor_key_check', sql`actor_key ~ '^[0-9a-f]{64}$'`),
  ],
)

/**
 * Curated registry of officially published camera feeds, with the same editorial gate as
 * `tools`. No search vector or tags: browsing is by geography and subject, and the set is
 * small.
 */
export const cameras = pgTable(
  'cameras',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('cameras_slug_key'),
    name: text('name').notNull(),
    /** The authority or company that publishes this feed. */
    operatorName: text('operator_name').notNull(),

    /** Null for link-out entries; required once embedded (see CHECK below). */
    connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'restrict' }),

    /** Not nullable: a camera whose jurisdiction is unknown cannot have its position assessed. */
    jurisdiction: text('jurisdiction').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    /** Human-readable place, e.g. the junction or landmark the camera points at. */
    locationLabel: text('location_label').notNull(),
    viewKind: text('view_kind', { enum: CAMERA_VIEW_KINDS }).notNull(),

    /** The operator's own page for this camera. Always present; always where we link. */
    sourceUrl: text('source_url').notNull(),
    /** The embeddable image or stream URL, when the licence permits embedding. */
    embedUrl: text('embed_url'),
    /** Fail closed: we link out unless an editor has established that embedding is permitted. */
    embedPermitted: boolean('embed_permitted').notNull().default(false),
    /** Why embedding is or is not permitted, citing the licence clause. Required to publish. */
    embedNotes: text('embed_notes'),
    /** The attribution string this feed obliges us to render, if any beyond the connector's. */
    attribution: text('attribution'),

    lastVerifiedAt: timestamptz('last_verified_at'),
    confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull().default('needsReview'),
    status: text('status', { enum: PUBLICATION_STATUSES }).notNull().default('draft'),
    publishedAt: timestamptz('published_at'),

    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('cameras_status_name_idx').on(t.status, t.name),
    index('cameras_status_jurisdiction_idx').on(t.status, t.jurisdiction, t.name),
    index('cameras_status_view_kind_idx').on(t.status, t.viewKind, t.name),
    index('cameras_connector_id_idx').on(t.connectorId),
    /** `/admin/queue`, alongside tools and playbooks. */
    index('cameras_confidence_verified_idx').on(t.confidence, t.lastVerifiedAt.asc().nullsFirst()),
    index('cameras_updated_by_id_idx').on(t.updatedById),

    check('cameras_view_kind_check', oneOf('view_kind', CAMERA_VIEW_KINDS)),
    check('cameras_status_check', oneOf('status', PUBLICATION_STATUSES)),
    check('cameras_confidence_check', oneOf('confidence', CONFIDENCE_LEVELS)),
    check('cameras_latitude_check', sql`latitude between -90 and 90`),
    check('cameras_longitude_check', sql`longitude between -180 and 180`),
    /** Same publish gate as tools and playbooks. */
    check(
      'cameras_published_requires_verification_check',
      sql`status <> 'published' or (last_verified_at is not null and embed_notes is not null)`,
    ),
    /** You cannot embed what you have no embed URL for. */
    check('cameras_embed_url_check', sql`embed_permitted = false or embed_url is not null`),
    /** Embedding needs a recorded legal basis, which lives on a connector. */
    check(
      'cameras_embed_requires_connector_check',
      sql`status <> 'published' or embed_permitted = false or connector_id is not null`,
    ),
  ],
)

/* ================================================================== *
 * Rate limiting: fixed-window counters in Postgres.
 * ================================================================== */

export const rateLimits = pgTable(
  'rate_limits',
  {
    /**
     * `<action>:<hashed subject>`, e.g. `signin-email:<hex>`. The subject is an HMAC of the
     * email or IP, never the raw value.
     */
    key: text('key').notNull(),
    /** Start of the fixed window, truncated to the window size by the caller. */
    windowStart: timestamptz('window_start').notNull(),
    count: integer('count').notNull().default(0),
    /** windowStart + windowLength. Drives the sweep; rows are never read after this. */
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'rate_limits_pkey', columns: [t.key, t.windowStart] }),
    index('rate_limits_expires_at_idx').on(t.expiresAt),
  ],
)

/* ================================================================== *
 * Relations — for the Drizzle relational query API (db.query.*)
 * ================================================================== */

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  workspaces: many(workspaces),
  workspaceItems: many(workspaceItems),
  notes: many(notes),
  reviews: many(reviews),
}))

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}))

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}))

export const categoriesRelations = relations(categories, ({ many }) => ({
  tools: many(tools),
  playbooks: many(playbooks),
}))

export const tagsRelations = relations(tags, ({ many }) => ({
  toolTags: many(toolTags),
}))

export const toolsRelations = relations(tools, ({ one, many }) => ({
  category: one(categories, { fields: [tools.categoryId], references: [categories.id] }),
  updatedBy: one(users, { fields: [tools.updatedById], references: [users.id] }),
  toolTags: many(toolTags),
  stepLinks: many(playbookStepTools),
  reviews: many(reviews),
  workspaceItems: many(workspaceItems),
}))

export const toolTagsRelations = relations(toolTags, ({ one }) => ({
  tool: one(tools, { fields: [toolTags.toolId], references: [tools.id] }),
  tag: one(tags, { fields: [toolTags.tagId], references: [tags.id] }),
}))

export const playbooksRelations = relations(playbooks, ({ one, many }) => ({
  category: one(categories, { fields: [playbooks.categoryId], references: [categories.id] }),
  updatedBy: one(users, { fields: [playbooks.updatedById], references: [users.id] }),
  steps: many(playbookSteps),
  workspaces: many(workspaces),
}))

export const playbookStepsRelations = relations(playbookSteps, ({ one, many }) => ({
  playbook: one(playbooks, { fields: [playbookSteps.playbookId], references: [playbooks.id] }),
  toolLinks: many(playbookStepTools),
  workspaceItems: many(workspaceItems),
  notes: many(notes),
}))

export const playbookStepToolsRelations = relations(playbookStepTools, ({ one }) => ({
  step: one(playbookSteps, {
    fields: [playbookStepTools.stepId],
    references: [playbookSteps.id],
  }),
  tool: one(tools, { fields: [playbookStepTools.toolId], references: [tools.id] }),
}))

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  user: one(users, { fields: [workspaces.userId], references: [users.id] }),
  playbook: one(playbooks, { fields: [workspaces.playbookId], references: [playbooks.id] }),
  items: many(workspaceItems),
  notes: many(notes),
  featureSnapshots: many(workspaceFeatureSnapshots),
}))

export const workspaceItemsRelations = relations(workspaceItems, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [workspaceItems.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, { fields: [workspaceItems.userId], references: [users.id] }),
  tool: one(tools, { fields: [workspaceItems.toolId], references: [tools.id] }),
  step: one(playbookSteps, { fields: [workspaceItems.stepId], references: [playbookSteps.id] }),
  notes: many(notes),
  /** Present exactly when `kind = 'mapFeature'`. */
  featureSnapshot: one(workspaceFeatureSnapshots, {
    fields: [workspaceItems.id],
    references: [workspaceFeatureSnapshots.workspaceItemId],
  }),
}))

export const workspaceFeatureSnapshotsRelations = relations(
  workspaceFeatureSnapshots,
  ({ one }) => ({
    item: one(workspaceItems, {
      fields: [workspaceFeatureSnapshots.workspaceItemId],
      references: [workspaceItems.id],
    }),
    workspace: one(workspaces, {
      fields: [workspaceFeatureSnapshots.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, { fields: [workspaceFeatureSnapshots.userId], references: [users.id] }),
  }),
)

export const notesRelations = relations(notes, ({ one }) => ({
  workspace: one(workspaces, { fields: [notes.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [notes.userId], references: [users.id] }),
  workspaceItem: one(workspaceItems, {
    fields: [notes.workspaceItemId],
    references: [workspaceItems.id],
  }),
  playbookStep: one(playbookSteps, {
    fields: [notes.playbookStepId],
    references: [playbookSteps.id],
  }),
}))

export const reviewsRelations = relations(reviews, ({ one }) => ({
  tool: one(tools, { fields: [reviews.toolId], references: [tools.id] }),
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
}))

export const connectorsRelations = relations(connectors, ({ one, many }) => ({
  updatedBy: one(users, { fields: [connectors.updatedById], references: [users.id] }),
  cameras: many(cameras),
  requests: many(connectorRequests),
}))

export const connectorRequestsRelations = relations(connectorRequests, ({ one }) => ({
  connector: one(connectors, {
    fields: [connectorRequests.connectorId],
    references: [connectors.id],
  }),
}))

export const camerasRelations = relations(cameras, ({ one }) => ({
  connector: one(connectors, { fields: [cameras.connectorId], references: [connectors.id] }),
  updatedBy: one(users, { fields: [cameras.updatedById], references: [users.id] }),
}))

/* ================================================================== *
 * Inferred row types
 * ================================================================== */

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Account = typeof accounts.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Category = typeof categories.$inferSelect
export type NewCategory = typeof categories.$inferInsert
export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert
export type Tool = typeof tools.$inferSelect
export type NewTool = typeof tools.$inferInsert
export type ToolTag = typeof toolTags.$inferSelect
export type NewToolTag = typeof toolTags.$inferInsert
export type Playbook = typeof playbooks.$inferSelect
export type NewPlaybook = typeof playbooks.$inferInsert
export type PlaybookStep = typeof playbookSteps.$inferSelect
export type NewPlaybookStep = typeof playbookSteps.$inferInsert
export type PlaybookStepTool = typeof playbookStepTools.$inferSelect
export type NewPlaybookStepTool = typeof playbookStepTools.$inferInsert
export type Workspace = typeof workspaces.$inferSelect
export type NewWorkspace = typeof workspaces.$inferInsert
export type WorkspaceItem = typeof workspaceItems.$inferSelect
export type NewWorkspaceItem = typeof workspaceItems.$inferInsert
export type Note = typeof notes.$inferSelect
export type NewNote = typeof notes.$inferInsert
export type WorkspaceFeatureSnapshot = typeof workspaceFeatureSnapshots.$inferSelect
export type NewWorkspaceFeatureSnapshot = typeof workspaceFeatureSnapshots.$inferInsert
export type Review = typeof reviews.$inferSelect
export type NewReview = typeof reviews.$inferInsert
export type RateLimit = typeof rateLimits.$inferSelect
export type NewRateLimit = typeof rateLimits.$inferInsert
export type Connector = typeof connectors.$inferSelect
export type NewConnector = typeof connectors.$inferInsert
export type ConnectorRequest = typeof connectorRequests.$inferSelect
export type NewConnectorRequest = typeof connectorRequests.$inferInsert
export type Camera = typeof cameras.$inferSelect
export type NewCamera = typeof cameras.$inferInsert

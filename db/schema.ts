/**
 * Database schema — the single structural source of truth.
 *
 * Conventions (see `docs/architecture/data-model.md` and the ADRs referenced there):
 *
 * - Primary keys are Postgres native `uuid` with `gen_random_uuid()` defaults,
 *   except where Auth.js dictates otherwise. See ADR 0003.
 * - Enumerated values are `text` columns with a Drizzle `enum` type hint plus a
 *   Postgres CHECK constraint. There are no Postgres ENUM types. See ADR 0004.
 * - All timestamps are `timestamptz` mapped to JS `Date`.
 * - Database identifiers are snake_case; TypeScript property names are camelCase.
 *   The Auth.js tables are the exception: their *property* names are fixed by the
 *   adapter (`refresh_token`, `providerAccountId`, ...); their column names are not.
 * - Every ownership-bearing row carries a `user_id` FK so authorisation is a join,
 *   not an application-layer assumption.
 * - Deletion is hard with `on delete cascade` except where a user's own record must
 *   survive an editorial change; those FKs are `on delete set null` and the row keeps a
 *   denormalised snapshot of what it referenced. See ADR 0008.
 * - The Live subtree (`connectors`, `connector_requests`, `cameras`) implements ADR 0011.
 *   Read the block comment above `connectors` before adding anything to it: what that
 *   subtree must never grow is as much a part of the design as what it contains.
 * - There is no `cached_features` table and no PostGIS, and both absences are decisions
 *   rather than gaps. ADR 0022. The live layers live in Redis with per-source TTLs, because
 *   the product does not claim to keep them; the one thing that is persisted is a feature a
 *   user deliberately saved (`workspace_feature_snapshots`, ADR 0025). Every coordinate in
 *   this file is `double precision` with a range CHECK, because nothing in this product
 *   issues a spatial predicate.
 *
 * Things this file deliberately does NOT contain, because drizzle-kit cannot generate
 * them and they live in a hand-written follow-up migration instead — the exact SQL is in
 * `docs/architecture/search.md` §7 and `docs/architecture/HANDOFF.md` §6:
 *
 * - `CREATE EXTENSION pg_trgm`
 * - the two `gin_trgm_ops` fuzzy-fallback indexes
 * - the DEFERRABLE unique constraint on `playbook_steps (playbook_id, order_index)`
 *
 * `drizzle-kit push` must never be run against any environment: it diffs against the live
 * database and would drop the objects created by that hand-written migration.
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

/**
 * `tsvector` has no first-class Drizzle column type. We only ever reference the column
 * inside raw SQL (`@@`, `ts_rank_cd`) and never select it, so a string-shaped custom type
 * is sufficient and keeps the generated DDL honest.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector'
  },
})

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/* ------------------------------------------------------------------ *
 * Enumerated value sets
 *
 * These arrays are the canonical definition. Zod schemas at every boundary are built from
 * them (`z.enum(CONFIDENCE_LEVELS)`), the CHECK constraints below are rendered from the
 * same literals, and the UI label maps key off them. Adding a value is a two-line change:
 * this array, and a migration that replaces the CHECK constraint.
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
 * product-brief.md §2, Directory table, `costModel`. Ordered as an ascending ladder of both
 * cost and exposure, so a UI that renders the array in order reads correctly.
 *
 * `freeWithRegistration` is a tier rather than a `costNotes` string because for this
 * audience it is a threat-model fact, not a pricing nuance. "Free" and "free once the
 * operator knows who you are" are materially different propositions: registration means an
 * identity, an email address and a query log held by the operator, which is a decision a
 * journalist or human-rights researcher must be able to make *before* touching the source.
 * Buried in prose it cannot be filtered on, cannot be badged, and will be missed by exactly
 * the reader who most needed it. As a tier it is a first-class facet of the directory.
 *
 * Spelling: camelCase, like every other CLOSED vocabulary here (`needsReview`,
 * `checklistStep`, `upstreamError`). The kebab-case forms in `lib/content/schema.ts` are
 * correct for the OPEN vocabularies it owns — `input_types` and `output_types` are
 * unconstrained `text[]`, never TypeScript union members, and kebab reads better as a
 * facet value. `costModel` is not one of those: it is a CHECK-constrained enum that code
 * branches on and that needs a label map, so it follows `confidence`. If the content
 * contract's `free-with-registration` is preferred instead, this array and
 * `lib/content/schema.ts` must change together — the CHECK constraint will reject any
 * mismatch loudly at seed time rather than storing a value the filters cannot see.
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

/**
 * product-brief.md §6.2 — how sure *we* are about an entry. Stored camelCase; the
 * human-readable labels live in the UI layer. See ADR 0007.
 */
export const CONFIDENCE_LEVELS = ['verified', 'high', 'medium', 'needsReview'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

export const DIFFICULTY_LEVELS = ['beginner', 'intermediate', 'advanced'] as const
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number]

export const WORKSPACE_STATUSES = ['active', 'completed', 'archived'] as const
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

/**
 * `tool` = a saved directory entry. `checklistStep` = an entry derived from a playbook step.
 * `mapFeature` = a live feature the user saved off the map (ADR 0025).
 *
 * The first two point at a row we own, so the item keeps an FK plus a snapshotted `title`.
 * `mapFeature` has nothing to point at: the referent is a position an upstream published
 * once and will not publish again. Its snapshot therefore has to be complete, and it lives
 * in `workspace_feature_snapshots` rather than in seven nullable columns here.
 *
 * `mapFeature` was added in migration 0006, which replaces the CHECK constraint.
 */
export const WORKSPACE_ITEM_KINDS = ['tool', 'checklistStep', 'mapFeature'] as const
export type WorkspaceItemKind = (typeof WORKSPACE_ITEM_KINDS)[number]

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * What a source's data is *about*. Mirrors `SOURCE_KINDS` in `lib/sources/types.ts`
 * value-for-value and must keep mirroring it.
 *
 * Deliberately duplicated rather than imported, for the same reason `COST_MODELS` is not
 * imported from `lib/content/schema.ts`: the CHECK constraint rendered from this array is a
 * database object, and a database object cannot be changed by editing a TypeScript file in
 * another package. If someone adds a twelfth kind to `lib/sources/types.ts` and not here,
 * the write is rejected loudly by `connectors_kind_check` at seed time rather than storing a
 * value the ops board cannot group. `db/schema.test.ts` asserts the two lists are equal, so
 * the drift is caught before it reaches a database at all.
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
 * One registry, not two. ADR 0024.
 *
 * `connectors` was designed in v1 for the two Live surfaces (`flights`, `cameras`); v2 adds
 * a dozen map sources with exactly the same needs — a recorded legal basis, an attribution
 * string, a TTL, a quota envelope, a kill-switch and a verification date. They are the same
 * concept and share this table. The alternative — a parallel `sources` table — would have
 * needed either a second audit log or a polymorphic FK on `connector_requests`, and would
 * have given an operator two places to look for a kill-switch during an incident.
 *
 * `flights` IS DEPRECATED AND MEANS `aircraft`. It is retained only because the v1 value is
 * live in seeded data and in `lib/connectors/flights.ts`, `db/seed.ts` and
 * `app/(public)/live/page.tsx`, which this file does not own. Two spellings for one data
 * kind is exactly the conflation this schema rejects elsewhere, so it is debt, recorded as
 * such: the coordinated rename is in ADR 0024 §Consequences and belongs in migration 0007.
 * **Do not write `flights` to a new row.**
 */
export const CONNECTOR_KINDS = [...SOURCE_KINDS, 'flights'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/**
 * How a source is polled, which is the difference between an upstream call rate that is
 * constant and one that scales with the number of people looking. ADR 0021 named the fix and
 * deferred it; this column is the half of it that is data rather than code.
 *
 *   `onDemand` — fetched in the request path, cached per source. The upstream call rate is
 *                bounded by the TTL but the *shape* of the traffic follows our readers.
 *   `worker`   — the worker container polls once, globally, on `cacheTtlSeconds`, and every
 *                viewport is served by filtering that one payload server-side. The upstream
 *                sees exactly one caller at one fixed rate, whether there is one reader or
 *                three hundred.
 *
 * The quota columns mean different things in the two modes and must not be read as if they
 * meant the same. Under `onDemand`, `globalCeiling` is the number of calls readers may
 * collectively cause; under `worker` it is a ceiling on the worker alone, and `perUserQuota`
 * governs nothing outbound at all — it is only a request-path limit on our own API.
 *
 * Defaults to `onDemand`, which is what every source does today. A source is promoted to
 * `worker` by an operator, deliberately, when the worker is actually running — not by
 * inheriting a default from a migration.
 */
export const POLL_MODES = ['onDemand', 'worker'] as const
export type PollMode = (typeof POLL_MODES)[number]

/**
 * Outcome of one outbound call. `quotaDenied`, `rateLimited` and `disabled` are recorded even
 * though no request left the building — a refusal is exactly the event an operator needs to
 * see. Stored camelCase, like every other vocabulary here (product-brief §6.2: one spelling,
 * no translation layer).
 *
 * `quotaDenied` AND `rateLimited` ARE DIFFERENT OPERATIONAL FACTS AND MUST NOT BE MERGED.
 * `quotaDenied` is *we* refused the caller, against a ceiling we chose. `rateLimited` is
 * *they* refused us — an HTTP 429 or 420, or our own cooldown standing down afterwards. An
 * operator reading the health board at 3am who sees `quotaDenied` will tune OUR quota; the
 * fix for `rateLimited` is to back off from THEIRS. Collapsing them sends the reader to the
 * wrong knob, which is the same conflation this codebase rejects everywhere else: confidence
 * versus reliability, our record versus the tool, intentionally published versus merely
 * reachable. QA finding Q-02.
 *
 * `rateLimited` was added in migration 0005, which replaces the CHECK constraint.
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

/**
 * What a camera looks at. Exactly the three kinds product-brief §2 names for the Live
 * pillar — no invented vocabulary. Extending is a two-line change (ADR 0004).
 */
export const CAMERA_VIEW_KINDS = ['traffic', 'transport', 'tourism'] as const
export type CameraViewKind = (typeof CAMERA_VIEW_KINDS)[number]

/** Renders the body of a CHECK constraint from an enum vocabulary. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`)

/* ================================================================== *
 * Auth.js v5 — @auth/drizzle-adapter tables
 *
 * The TypeScript *property* names below are load-bearing: PostgresDrizzleAdapter accesses
 * them directly (`usersTable.emailVerified`, `accountsTable.providerAccountId`,
 * `accountsTable.refresh_token`). Renaming a property breaks authentication at runtime.
 * Database column names are ours to choose.
 *
 * The optional `authenticators` (WebAuthn) table is intentionally absent: v1 ships email
 * magic link and GitHub OAuth only (product-brief §5).
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

/**
 * A single flat taxonomy of investigative domains, shared by tools and playbooks. There is
 * no `kind` discriminator: "corporate records" is the same domain whether it names a
 * directory section or a methodology, and splitting it would duplicate every label.
 * See data-model.md §4.
 */
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

    /**
     * Controlled vocabularies, but open-ended ones — the canonical value lists live in the
     * Zod layer, not in the database, because they grow with the catalogue and a CHECK on
     * array membership would turn every content addition into a migration. See ADR 0004.
     */
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

    /** Where the tool or its underlying data sits. Free text; convention in HANDOFF §3. */
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
     * Denormalised search surface: category name, tag names, input types and output types,
     * flattened to whitespace-separated text on write. It exists because a Postgres
     * generated column may only call IMMUTABLE functions and `array_to_string` is STABLE.
     * See ADR 0005 and search.md §3.
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
    /**
     * Credibility is enforced in the database, not only in the form: nothing reaches the
     * public catalogue without a verification date and a reliability rating. ADR 0007.
     */
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

    /** Playbooks carry the same accuracy metadata as tools: product-brief §6.2 says *every* entry. */
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
    /** The completion criterion. product-brief §2: "states how you know the step is done". */
    doneWhen: text('done_when').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * Ordering index only. Uniqueness of (playbook_id, order_index) is enforced by a
     * DEFERRABLE INITIALLY DEFERRED constraint added in the hand-written migration, so a
     * drag-to-reorder can rewrite every index inside one transaction without shuffling
     * through temporary values. drizzle-kit cannot express DEFERRABLE. See HANDOFF §6.
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
 * Workspaces — the user's own case file
 *
 * product-brief §3.2: the user is the controller of their case file, not us. Nothing here
 * is an entity record about an investigation *subject*; these are the user's saved links,
 * their checklist state, and their own prose.
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

    /**
     * Snapshot of the referenced tool name or step title, taken when the item was added.
     * A user's checklist must not silently change or vanish because an editor renamed or
     * removed the source. ADR 0008.
     */
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
     * Deliberately no CHECK tying `kind` to a non-null `tool_id` / `step_id`: those FKs are
     * ON DELETE SET NULL, and Postgres re-evaluates CHECK constraints on the resulting
     * UPDATE, which would make the constraint block editorial deletes. The invariant is
     * enforced in Zod on write instead. ADR 0004.
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
 * A live map feature, as it was when a user saved it into a case file. ADR 0025.
 *
 * ## Why this table exists when there is no `cached_features` table
 *
 * ADR 0022 refuses to persist the live layers: an aircraft position from six hours ago is
 * not something this product claims to keep, and a durable table of them is the aircraft
 * position table the block comment below `reviews` forbids on sight. This table is the one
 * exception, and it is an exception for a reason that does not generalise: **the user asked
 * for it.** A feature saved into a workspace is the user's own case material, the same
 * category as a `note`, and it must survive the upstream forgetting it — which upstreams do,
 * within seconds. Nothing here is written unless a signed-in person clicked save.
 *
 * The distinction is the same one product-brief §3.2 constraint 3 draws: we are not the
 * controller of a dossier we assembled, we are the host of a case file its owner assembled.
 * Everything here cascades from `users`, so a deleted account takes it with it.
 *
 * ## The snapshot is complete, and it is immutable
 *
 * `workspace_items` snapshots a `title` and keeps an FK for the rest (ADR 0008). That is not
 * available here: there is no local row to point at and never will be, because the referent
 * is one observation an upstream published once. So every field the export and the feature
 * panel render is on this row, including the attribution and licence owed at save time — a
 * saved feature rendered in an exported case file still owes its credit, and the connector
 * row it came from may have been edited or deleted by then.
 *
 * There is a `createdAt` and deliberately **no `updatedAt`**: a record of what an upstream
 * said at 14:32 has no correct edit. The user's changing view of it belongs in a `note`.
 *
 * ## One save per feature per workspace, and no track history
 *
 * `workspace_feature_snapshots_unique_idx` allows a feature to be saved into a workspace
 * once. Re-saving is a no-op that reports "already saved". The rejected alternative was to
 * let a user accumulate positions for the same aircraft over time, which is a flight-track
 * table assembled one click at a time — the thing the Live block comment forbids, arrived at
 * by a route that felt like a feature. A user who needs a sequence of observations writes
 * timestamped notes, which is what `notes` is for.
 *
 * ## `featureRef` is deliberately not indexed on its own
 *
 * Same reasoning as the absent index on `connector_requests.actor_key`. A standalone index
 * would make "every workspace that saved this aircraft" a fast query across users, which is
 * a surveillance affordance this product has no use for. The leading column of every index
 * here is a workspace or a user.
 */
export const workspaceFeatureSnapshots = pgTable(
  'workspace_feature_snapshots',
  {
    /** PK *and* FK: exactly one snapshot per `mapFeature` item, enforced structurally. */
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

    /**
     * The adapter slug (`SourceAdapter.slug`), as text and deliberately **not** an FK to
     * `connectors`. A source we retire, or a registry row an operator deletes, must not take
     * a user's saved evidence with it — the same reasoning that makes `workspaceItems.toolId`
     * `on delete set null` with the name kept alongside it. ADR 0008.
     */
    sourceSlug: text('source_slug').notNull(),
    /** The source's display name at save time, so the export reads correctly without a join. */
    sourceName: text('source_name').notNull(),
    sourceKind: text('source_kind', { enum: SOURCE_KINDS }).notNull(),

    /**
     * `SourceFeature.id` — stable within a source across polls. Used only to recognise a
     * re-save within the same workspace. Never joined on, never indexed alone.
     */
    featureRef: text('feature_ref').notNull(),

    /**
     * Plain `double precision`, not PostGIS. ADR 0022: there is no spatial predicate anywhere
     * in this product. The only query over this table is "the features in this workspace",
     * and the map draws them from a list of at most a few hundred points. `cameras` already
     * stores coordinates this way for the same reason.
     */
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    /** Metres, where the source published it. */
    altitudeMetres: doublePrecision('altitude_metres'),

    /**
     * When the **upstream** observed this, not when we cached it and not when the user
     * clicked save. It is the whole value of the row: a saved feature is a claim about a
     * moment, and a moment we recorded from our own clock would be a different claim.
     */
    observedAt: timestamptz('observed_at').notNull(),

    /** Where a reader gets back to the origin, when the source publishes a per-feature URL. */
    sourceUrl: text('source_url'),

    /**
     * The credit owed for this data, captured at save time. Not nullable: several of these
     * licences — ODbL, CC BY, the TfL terms — make attribution a condition of use, so a
     * feature saved without its credit is a licence breach waiting to be exported. The same
     * fail-closed posture as `connectors_attribution_check`.
     */
    attribution: text('attribution').notNull(),
    licence: text('licence').notNull(),

    /**
     * `SourceFeature.properties` as stored — the adapter-specific detail the feature panel
     * and the export render. `jsonb` because the shape is genuinely per-source and modelling
     * eleven source kinds as columns would be eleven mostly-null column sets. A CHECK keeps
     * it an object rather than a bare scalar or array.
     */
    properties: jsonb('properties').notNull().default({}),

    /** Set once. There is no `updatedAt` — see the block comment. */
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
 * Reviews — designed, NOT exposed in v1. See data-model.md §8 and ADR 0010.
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
 * Live — the connector seam, built. ADR 0011, 0012, 0013, 0014.
 *
 * WHAT THIS SUBTREE MUST NEVER GROW
 * ---------------------------------
 * product-brief §2 (Live) and ADR 0011 rule 8: *live means live*. The following tables and
 * columns are forbidden, and a pull request adding one is rejected on sight:
 *
 *   - Any table of aircraft positions, tracks, callsigns, registrations or flight history.
 *   - Any table or column holding camera imagery, thumbnails, frames or video, in any
 *     encoding, including a "cache" of them. Retaining imagery turns us from a viewer into
 *     a redistributor and, for anything with a person in frame, a controller of their image
 *     data.
 *   - Any column on `connector_requests` recording *what* was asked for: no path, no query
 *     string, no parameters, no bounding box, no camera id, no response body. The audit log
 *     records that a call happened, what it cost and how it ended. Never its content.
 *   - Any raw actor identifier anywhere in this subtree. See `connectorRequests.actorKey`.
 *   - Any durable store of live map features — a `cached_features` table, a "layer cache"
 *     table, a materialised view of the last poll. ADR 0022. Renaming the aircraft position
 *     table to `cached_features` and giving it a `kind` column does not make it a different
 *     table. The live cache is Redis, it expires, and that is the product's claim about it.
 *
 * The absence of these tables is the design, not an omission to be filled in later.
 * ================================================================== */

/**
 * The connector registry. One row per upstream we are permitted to call, carrying the legal
 * basis for calling it, the attribution we owe, its quota envelope, its freshness policy and
 * its kill-switch.
 *
 * Two independent axes, deliberately not merged:
 *   - `status`  — editorial. Is this connector part of the shipped product? draft/published.
 *   - `enabled` — operational. May it make a request *right now*? Defaults to false, so a
 *                 newly seeded connector is inert until an operator turns it on, and a
 *                 source that changes its terms is stopped by a config change rather than
 *                 a deploy (ADR 0011 rule 6).
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
    /**
     * The exact string we are obliged to render next to the data. Nullable *only* when
     * `attributionRequired` is false — the pair forces an explicit editorial statement so
     * "no attribution is required" is distinguishable from "nobody filled this in".
     */
    attribution: text('attribution'),
    attributionRequired: boolean('attribution_required').notNull().default(true),
    /** Why we are permitted to do this, in prose, citing the clause. Required to publish. */
    legalBasis: text('legal_basis'),

    baseUrl: text('base_url').notNull(),
    requiresApiKey: boolean('requires_api_key').notNull().default(false),
    /**
     * The NAME of the environment variable holding the credential — never the credential.
     * A CHECK constraint restricts this to `^[A-Z][A-Z0-9_]*$`, which no real API key
     * matches, so the schema itself refuses to become a place secrets can be pasted.
     */
    apiKeyEnvVar: text('api_key_env_var'),

    /** Requests per `windowSeconds`, per user. Enforced through `rate_limits` (ADR 0009). */
    perUserQuota: integer('per_user_quota').notNull(),
    /** Requests per `windowSeconds` across all users, so we cannot breach upstream fair use. */
    globalCeiling: integer('global_ceiling').notNull(),
    windowSeconds: integer('window_seconds').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),

    /** How long a fetched payload is served as fresh. ADR 0014. */
    cacheTtlSeconds: integer('cache_ttl_seconds').notNull(),
    /** How long past the TTL we keep serving, labelled stale, before the degraded state. */
    staleWhileRevalidateSeconds: integer('stale_while_revalidate_seconds').notNull(),

    /**
     * Whether the worker polls this source once for everyone, or the request path fetches it.
     * See `POLL_MODES`. Added in migration 0006; ADR 0021's deferred fan-out, as data.
     */
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
    /** "Give me the live connectors for this surface" — the only hot read on this table. */
    index('connectors_kind_status_enabled_idx').on(t.kind, t.status, t.enabled),
    index('connectors_updated_by_id_idx').on(t.updatedById),

    check('connectors_kind_check', oneOf('kind', CONNECTOR_KINDS)),
    check('connectors_status_check', oneOf('status', PUBLICATION_STATUSES)),
    check('connectors_poll_mode_check', oneOf('poll_mode', POLL_MODES)),
    /**
     * ADR 0011 rule 1, enforced by the database rather than by remembering: a connector
     * with no recorded licence, no legal basis and no verification date cannot be published.
     * Mirrors `tools_published_requires_verification_check`. ADR 0012.
     */
    check(
      'connectors_published_requires_legal_basis_check',
      sql`status <> 'published' or (terms_url is not null and legal_basis is not null and last_checked_at is not null)`,
    ),
    /** ADR 0011 rule 2: if attribution is owed, the string we owe must be on the row. */
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
 * The outbound audit log required by product-brief §3.3 and ADR 0011 rule 6.
 *
 * It answers operational questions — is this connector failing, how often are we being
 * quota-denied, how slow is upstream — and deliberately cannot answer "who looked at what".
 * There is no column for the request content, and the actor is a keyed hash. ADR 0013.
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
     * `HMAC-SHA256(userId or client IP, RATE_LIMIT_SECRET)`, lowercase hex — the same
     * construction as `rate_limits.key` (ADR 0009). A CHECK constraint requires exactly 64
     * hex characters, so a raw user id, email or IP address is structurally impossible to
     * store here: a uuid contains hyphens, an email an `@`, an IPv4 address dots. The
     * constraint is the enforcement; the code convention is only the first line of defence.
     */
    actorKey: text('actor_key').notNull(),
    /** Retention horizon. This table grows unboundedly and is swept, not archived. ADR 0013. */
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (t) => [
    /** Per-connector health and error rate over a time window — the ops read. */
    index('connector_requests_connector_time_idx').on(t.connectorId, t.requestedAt.desc()),
    index('connector_requests_outcome_time_idx').on(t.outcome, t.requestedAt.desc()),
    index('connector_requests_expires_at_idx').on(t.expiresAt),
    /*
     * There is deliberately NO index on `actor_key`. Indexing it would make "everything this
     * actor did" a fast query, which is the surveillance affordance ADR 0013 exists to
     * remove. Quota enforcement does not need it either — that runs against `rate_limits`.
     */
    check('connector_requests_outcome_check', oneOf('outcome', CONNECTOR_REQUEST_OUTCOMES)),
    check('connector_requests_duration_check', sql`duration_ms >= 0`),
    check(
      'connector_requests_upstream_status_check',
      sql`upstream_status is null or upstream_status between 100 and 599`,
    ),
    check('connector_requests_actor_key_check', sql`actor_key ~ '^[0-9a-f]{64}$'`),
  ],
)

/**
 * The curated registry of *officially published* camera feeds. Content, held to the same
 * editorial standard as `tools`: operator, jurisdiction, source, confidence, verification
 * date, and the same publish gate.
 *
 * Cameras carry no `search_vector` and no tags. See `data-model.md` §11 for why: the browse
 * axes here are geography and subject, both of which are columns, and the registry is small
 * enough that the whole published set is one cached query.
 */
export const cameras = pgTable(
  'cameras',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique('cameras_slug_key'),
    name: text('name').notNull(),
    /** The authority or company that publishes this feed. */
    operatorName: text('operator_name').notNull(),

    /**
     * The connector this feed is reached through. Nullable: an entry we merely link out to
     * needs no connector, because the user's browser goes to the operator directly and we
     * make no outbound call. A CHECK below requires one as soon as we embed.
     */
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
    /** Same credibility gate as tools and playbooks. ADR 0007. */
    check(
      'cameras_published_requires_verification_check',
      sql`status <> 'published' or (last_verified_at is not null and embed_notes is not null)`,
    ),
    /** You cannot embed what you have no embed URL for. */
    check('cameras_embed_url_check', sql`embed_permitted = false or embed_url is not null`),
    /**
     * ADR 0011 rule 1 again: the moment we render a third party's feed inside our own page
     * we are making a call that needs a recorded legal basis, and a legal basis lives on a
     * connector. A link-out entry needs none.
     */
    check(
      'cameras_embed_requires_connector_check',
      sql`status <> 'published' or embed_permitted = false or connector_id is not null`,
    ),
  ],
)

/* ================================================================== *
 * Rate limiting — fixed-window counters in Postgres. There is no Redis. ADR 0009.
 * ================================================================== */

export const rateLimits = pgTable(
  'rate_limits',
  {
    /**
     * `<action>:<hashed subject>`, e.g. `signin-email:<hex>`. The subject is an
     * HMAC-SHA256 of the email address or IP with a server-side secret, never the raw
     * value: product-brief §3.2 forbids building an interest graph of this audience, and a
     * plaintext IP column in a rate-limit table is exactly that.
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
  /** Present exactly when `kind = 'mapFeature'`. ADR 0025. */
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

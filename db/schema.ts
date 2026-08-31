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
  index,
  integer,
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

/** product-brief.md §2, Directory table, `costModel`. */
export const COST_MODELS = ['free', 'freemium', 'paid', 'subscription', 'enterprise'] as const
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

/** `tool` = a saved directory entry. `checklistStep` = an entry derived from a playbook step. */
export const WORKSPACE_ITEM_KINDS = ['tool', 'checklistStep'] as const
export type WorkspaceItemKind = (typeof WORKSPACE_ITEM_KINDS)[number]

export const REVIEW_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

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
}))

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
export type Review = typeof reviews.$inferSelect
export type NewReview = typeof reviews.$inferInsert
export type RateLimit = typeof rateLimits.$inferSelect
export type NewRateLimit = typeof rateLimits.$inferInsert

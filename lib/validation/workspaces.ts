import { z } from "zod";

import { markdownSchema, uuidSchema } from "./common";
import { sourceKindSchema, workspaceItemKindSchema, workspaceStatusSchema } from "./vocabulary";

/**
 * Write-side validation for `workspaces`, `workspace_items` and `notes`.
 *
 * THE INVARIANT THE DATABASE DELIBERATELY DOES NOT ENFORCE (HANDOFF §3, ADR 0004/0008):
 *
 *   kind = 'tool'          => tool_id is present ON INSERT
 *   kind = 'checklistStep' => step_id is present ON INSERT
 *
 * There is no CHECK constraint for this, and adding one would be a bug rather than a
 * belt-and-braces improvement: both FKs are `ON DELETE SET NULL`, Postgres re-evaluates a
 * CHECK on the UPDATE that `SET NULL` performs, and the constraint would therefore turn an
 * ordinary editorial delete into a constraint violation — defeating ADR 0008 entirely.
 *
 * So the rule holds at the moment of insert and is *expected* to stop holding later. A
 * workspace item with a null `tool_id` and a non-null `title` is the normal state of a
 * long-running case, not corruption.
 */

/** A user's own title for a case. Bounded so it renders in a list without truncation logic. */
const workspaceTitleSchema = z.string().trim().min(1, "Give the case a name").max(160);

export const createWorkspaceSchema = z.object({
  title: workspaceTitleSchema,
  /**
   * Optional provenance. When present, the action derives a checklist from the playbook's
   * steps. The playbook must be published — starting a case from a draft would expose
   * unpublished editorial work through a side door.
   */
  playbookId: uuidSchema.nullable().default(null),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z.object({
  id: uuidSchema,
  title: workspaceTitleSchema,
  status: workspaceStatusSchema,
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const workspaceIdSchema = z.object({ id: uuidSchema });

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

/**
 * The precision caveat, carried into the snapshot so it survives the boundary.
 *
 * Without this a reader could save an NWS alert and read a precise-looking coordinate in a
 * PDF export months later, with nothing left to say it is an administrative centroid possibly
 * tens of kilometres from the weather. The map renders that caveat from the LIVE feature; an
 * export never touches the map. The honest place for it is on the saved record.
 */
export const savedPrecisionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  note: z.string().trim().min(1).max(400),
  approximateRadiusMetres: z.number().positive().finite().optional(),
});
export type SavedPrecision = z.infer<typeof savedPrecisionSchema>;

const featurePropertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * WHAT IS WRITTEN INTO `workspace_feature_snapshots`. **Server-side only.**
 *
 * ## Read this before adding a field, and before letting one through from a request
 *
 * Nothing validated by this schema comes from a browser, and that is the whole point. QA
 * finding QV-14: every one of these fields used to be client-asserted, on a table whose
 * entire purpose is to be quotable evidence months after the upstream forgot the feature. An
 * export that looks like sourced evidence and was assembled from a POST body is a credibility
 * problem for a product whose output is meant to be citable — and `attribution` and `licence`
 * are worse than that, because ODbL, CC BY and the TfL terms make the credit a *condition of
 * use*. A licence obligation a crafted request can blank is a licence breach with a UI in
 * front of it.
 *
 * So `addWorkspaceItemSchema` accepts only a REFERENCE — `savedFeatureRefSchema` below — and
 * `addWorkspaceItem` resolves the rest from `lib/live/feature-cache.ts`, which holds what the
 * governed poll actually returned. This schema is the boundary between that cache and the
 * database: not a request boundary, a "we are about to write evidence" boundary.
 *
 * `.trim()` BEFORE `.min(1)` on every string that carries an obligation. Zod applies the
 * transform first, so `" "` fails — where `.min(1)` alone accepted it and rendered as an
 * empty credit line in the Markdown and PDF exports (QV-14, first half).
 */
export const savedFeatureSchema = z.object({
  sourceSlug: z.string().trim().min(1).max(64),
  sourceName: z.string().trim().min(1).max(160),
  sourceKind: sourceKindSchema,
  /** The upstream's own id, so a reader can go back and look it up. */
  featureRef: z.string().trim().min(1).max(256),
  /** What the reader saw. Becomes `workspace_items.title` (ADR 0008). */
  label: z.string().trim().min(1).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitudeMetres: z.number().finite().nullable().default(null),
  /** When the upstream observed it — never when we saved it. */
  observedAt: z.coerce.date(),
  sourceUrl: z.string().url().nullable().default(null),
  attribution: z.string().trim().min(1),
  licence: z.string().trim().min(1),
  properties: z.record(featurePropertyValueSchema).default({}),
  precision: savedPrecisionSchema.nullable().default(null),
});
export type SavedFeatureInput = z.infer<typeof savedFeatureSchema>;

/**
 * WHAT A CLIENT MAY SEND: the pair that identifies one observation, and nothing else.
 *
 * ADR 0025 Consequences and QV-14. Unknown keys are STRIPPED rather than rejected, which is
 * deliberate: a request carrying `attribution` does not fail loudly, it simply has no field
 * to put it in. There is nothing here to blank.
 */
export const savedFeatureRefSchema = z.object({
  sourceSlug: z.string().trim().min(1).max(64),
  featureRef: z.string().trim().min(1).max(256),
});
export type SavedFeatureRef = z.infer<typeof savedFeatureRefSchema>;

/* ------------------------------------------------------------------ *
 * `properties`, and the one thing it has to carry that has no column
 * ------------------------------------------------------------------ */

/**
 * The reserved key under which `precision` rides inside `properties`.
 *
 * `workspace_feature_snapshots` has no `precision` column — ADR 0025 lists the payload fields
 * and does not mention it, while `savedFeatureSchema` has carried it since the schema was
 * written, because `SourceFeature.precision` is the caveat that must survive into an export.
 * Adding a column is a migration; these two functions are a smaller, entirely reversible
 * answer that keeps every adapter property exactly where the block comment in `db/schema.ts`
 * says it is — at the top level of the object.
 *
 * `$` cannot begin an adapter property name — every one of them is a camelCase identifier
 * from a `normalise()` in `lib/sources/` — so the key cannot collide with real data, and it
 * reads as reserved metadata rather than as something the upstream published.
 *
 * If a later migration adds the column, `unpackSnapshotProperties` keeps reading old rows and
 * this constant is deleted with the pack side. Written up in `docs/frontend/HANDOFF-map.md`.
 */
export const PRECISION_PROPERTY_KEY = "$precision";

/** What actually goes into the `properties` jsonb column. */
export function packSnapshotProperties(
  properties: Readonly<Record<string, string | number | boolean | null>>,
  precision: SavedPrecision | null,
): Record<string, unknown> {
  const packed: Record<string, unknown> = { ...properties };
  if (precision) packed[PRECISION_PROPERTY_KEY] = precision;
  return packed;
}

/**
 * The inverse, applied on every read.
 *
 * `unknown` in, narrowed here — the column is `jsonb`, and a row written by an older build is
 * exactly as much of an unvalidated boundary as an upstream response. Anything that does not
 * parse is dropped rather than rendered. `precision` comes back `null` only when the stored
 * value genuinely had none, so an absent caveat and an unreadable one are the same answer and
 * both are the safe one: no claim of precision is made either way.
 */
export function unpackSnapshotProperties(raw: unknown): {
  properties: Record<string, string | number | boolean | null>;
  precision: SavedPrecision | null;
} {
  const parsed = z.record(z.unknown()).safeParse(raw);
  if (!parsed.success) return { properties: {}, precision: null };

  const properties: Record<string, string | number | boolean | null> = {};
  let precision: SavedPrecision | null = null;

  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === PRECISION_PROPERTY_KEY) {
      const caveat = savedPrecisionSchema.safeParse(value);
      if (caveat.success) precision = caveat.data;
      continue;
    }
    const scalar = featurePropertyValueSchema.safeParse(value);
    if (scalar.success) properties[key] = scalar.data;
  }

  return { properties, precision };
}

/**
 * `title` is NOT accepted from the client. It is snapshotted server-side from `tools.name`,
 * `playbook_steps.title`, or — for a `mapFeature` — the resolved feature's own label at
 * insert (ADR 0008), because it is a record of what the user saw; a client-supplied title
 * would be a record of what the client claimed.
 */
export const addWorkspaceItemSchema = z
  .object({
    workspaceId: uuidSchema,
    kind: workspaceItemKindSchema,
    toolId: uuidSchema.nullable().default(null),
    stepId: uuidSchema.nullable().default(null),
    /**
     * Required exactly when `kind = "mapFeature"`, and it is a REFERENCE, not a snapshot.
     *
     * The snapshot is built server-side by `addWorkspaceItem` from the shared source cache.
     * See `savedFeatureRefSchema` for why this is two fields rather than fourteen.
     */
    feature: savedFeatureRefSchema.nullable().default(null),
  })
  .superRefine((item, ctx) => {
    if (item.kind === "tool") {
      if (!item.toolId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toolId"],
          message: "A saved tool must reference a tool",
        });
      }
      if (item.stepId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stepId"],
          message: "A saved tool must not also reference a playbook step",
        });
      }
    }

    if (item.kind === "checklistStep") {
      if (!item.stepId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stepId"],
          message: "A checklist entry must reference a playbook step",
        });
      }
      if (item.toolId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toolId"],
          message: "A checklist entry must not also reference a tool",
        });
      }
    }

    // `mapFeature` is the kind with nothing to point at. Its referent is a position an
    // upstream published for a moment — no row in our database owns it, and by the time the
    // user opens the case that aircraft has moved and that wildfire may be out. So it carries
    // neither FK, and everything worth keeping is copied into `workspace_feature_snapshots`
    // at save time. A dangling reference to something ephemeral would be worse than a
    // snapshot: it would silently become wrong rather than visibly become old.
    if (item.kind === "mapFeature") {
      if (item.toolId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toolId"],
          message: "A saved map feature must not reference a tool",
        });
      }
      if (item.stepId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stepId"],
          message: "A saved map feature must not reference a playbook step",
        });
      }
      if (!item.feature) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["feature"],
          message:
            "A saved map feature must name the source and the feature it is a record of",
        });
      }
    }
  });
export type AddWorkspaceItemInput = z.infer<typeof addWorkspaceItemSchema>;

export const toggleWorkspaceItemSchema = z.object({
  id: uuidSchema,
  checked: z.boolean(),
});
export type ToggleWorkspaceItemInput = z.infer<typeof toggleWorkspaceItemSchema>;

export const removeWorkspaceItemSchema = z.object({ id: uuidSchema });

/**
 * Reorder within one kind. `workspace_items` has no deferrable constraint and no uniqueness
 * on `order_index` — the ordering is presentational within a workspace, so gaps are
 * survivable. The action still rewrites the whole list contiguously, because a list whose
 * indexes drift apart eventually collides on the default `0`.
 */
export const reorderWorkspaceItemsSchema = z
  .object({
    workspaceId: uuidSchema,
    kind: workspaceItemKindSchema,
    itemIds: z.array(uuidSchema).min(1),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.itemIds).size !== input.itemIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["itemIds"],
        message: "The same item appears twice in the new order",
      });
    }
  });
export type ReorderWorkspaceItemsInput = z.infer<typeof reorderWorkspaceItemsSchema>;

/* ------------------------------------------------------------------ *
 * Notes
 * ------------------------------------------------------------------ */

/**
 * The user's own prose. It is never parsed for entities and never indexed for search
 * (db/schema.ts, `notes.body`): product-brief §3.2 constraint 3 makes the user the
 * controller of their case file, and extracting structure from their notes would make us a
 * controller of data about the people in them.
 *
 * The upper bound is a denial-of-service ceiling, not an editorial one — 64 KiB of Markdown
 * is far more than anyone types and far less than a paste bomb.
 */
export const NOTE_MAX = 64 * 1024;

export const createNoteSchema = z.object({
  workspaceId: uuidSchema,
  body: markdownSchema.max(NOTE_MAX, "That note is too long to store as a single entry"),
  /** Optional anchors. Both may be null: a note can belong to the case as a whole. */
  workspaceItemId: uuidSchema.nullable().default(null),
  playbookStepId: uuidSchema.nullable().default(null),
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

/**
 * Editing a note rewrites `body` and `updated_at` only. `created_at` is the "timestamped" in
 * "timestamped notes" and is never rewritten (db/schema.ts, `notes.createdAt`) — an
 * investigator's record of *when* they wrote something is the part that has to be stable.
 */
export const updateNoteSchema = z.object({
  id: uuidSchema,
  body: markdownSchema.max(NOTE_MAX, "That note is too long to store as a single entry"),
});
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

export const deleteNoteSchema = z.object({ id: uuidSchema });

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export const exportFormatSchema = z.enum(["md", "pdf"]).catch("md");
export type ExportFormat = z.infer<typeof exportFormatSchema>;

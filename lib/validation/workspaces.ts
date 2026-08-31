import { z } from "zod";

import { markdownSchema, uuidSchema } from "./common";
import { workspaceItemKindSchema, workspaceStatusSchema } from "./vocabulary";

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
 * `title` is NOT accepted from the client. It is snapshotted server-side from `tools.name`
 * or `playbook_steps.title` at insert (ADR 0008), because it is a record of what the user
 * saw — a client-supplied title would be a record of what the client claimed.
 */
/**
 * What is copied out of a live layer when a reader saves a feature into a case.
 *
 * Everything needed to render the item months later, including the attribution and licence,
 * because the obligation to credit the source does not lapse when the source forgets the
 * feature — and by then we cannot go back and ask what it was.
 */
export const savedFeatureSchema = z.object({
  sourceSlug: z.string().min(1).max(64),
  sourceName: z.string().min(1).max(160),
  sourceKind: z.string().min(1).max(32),
  /** The upstream's own id, so a reader can go back and look it up. */
  featureRef: z.string().min(1).max(256),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitudeMetres: z.number().finite().nullable().default(null),
  /** When the upstream observed it — never when we saved it. */
  observedAt: z.coerce.date(),
  sourceUrl: z.string().url().nullable().default(null),
  attribution: z.string().min(1),
  licence: z.string().min(1),
  properties: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type SavedFeatureInput = z.infer<typeof savedFeatureSchema>;

export const addWorkspaceItemSchema = z
  .object({
    workspaceId: uuidSchema,
    kind: workspaceItemKindSchema,
    toolId: uuidSchema.nullable().default(null),
    stepId: uuidSchema.nullable().default(null),
    /** Required exactly when `kind = "mapFeature"`. */
    feature: savedFeatureSchema.nullable().default(null),
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
            "A saved map feature must carry its snapshot: the live source will not have it later",
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

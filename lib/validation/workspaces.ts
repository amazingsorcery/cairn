import { z } from "zod";

import { markdownSchema, uuidSchema } from "./common";
import { sourceKindSchema, workspaceItemKindSchema, workspaceStatusSchema } from "./vocabulary";

/**
 * Write-side validation for `workspaces`, `workspace_items` and `notes`.
 *
 * Enforced on insert only, not in the database:
 *   kind = 'tool'          => tool_id is present
 *   kind = 'checklistStep' => step_id is present
 *
 * A CHECK would fire on the `ON DELETE SET NULL` update and block deletes. A null `tool_id`
 * with a title later on is normal.
 */

/** A user's title for a case. */
const workspaceTitleSchema = z.string().trim().min(1, "Give the case a name").max(160);

export const createWorkspaceSchema = z.object({
  title: workspaceTitleSchema,
  /** Optional; seeds a checklist from the playbook's steps. Must be a published playbook. */
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
 * Precision caveat stored with the snapshot, so exports still say e.g. that an NWS alert's
 * coordinate is a zone centroid.
 */
export const savedPrecisionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  note: z.string().trim().min(1).max(400),
  approximateRadiusMetres: z.number().positive().finite().optional(),
});
export type SavedPrecision = z.infer<typeof savedPrecisionSchema>;

const featurePropertyValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * What is written to `workspace_feature_snapshots`. Server-side only: the client sends just a
 * reference (`savedFeatureRefSchema`) and `addWorkspaceItem` resolves the rest from
 * `lib/live/feature-cache.ts`. Don't accept these fields from a request; attribution and
 * licence are conditions of use (ODbL, CC BY, TfL).
 *
 * `.trim()` runs before `.min(1)`, so whitespace-only strings fail.
 */
export const savedFeatureSchema = z.object({
  sourceSlug: z.string().trim().min(1).max(64),
  sourceName: z.string().trim().min(1).max(160),
  sourceKind: sourceKindSchema,
  /** The upstream's own id, so a reader can go back and look it up. */
  featureRef: z.string().trim().min(1).max(256),
  /** What the reader saw. Becomes `workspace_items.title`. */
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

/** What a client may send: the pair identifying one observation. Unknown keys are stripped. */
export const savedFeatureRefSchema = z.object({
  sourceSlug: z.string().trim().min(1).max(64),
  featureRef: z.string().trim().min(1).max(256),
});
export type SavedFeatureRef = z.infer<typeof savedFeatureRefSchema>;

/* ------------------------------------------------------------------ *
 * `properties` (also carries `precision`)
 * ------------------------------------------------------------------ */

/**
 * Reserved key for `precision` inside `properties`, since the snapshots table has no
 * `precision` column. Adapter property names are camelCase identifiers, so `$` can't collide.
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
 * Inverse of `packSnapshotProperties`. The jsonb is untrusted: unparseable values are dropped,
 * and a missing or invalid caveat yields `precision: null`.
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
 * `title` isn't accepted from the client; it's snapshotted server-side from `tools.name`,
 * `playbook_steps.title`, or the resolved feature's label.
 */
export const addWorkspaceItemSchema = z
  .object({
    workspaceId: uuidSchema,
    kind: workspaceItemKindSchema,
    toolId: uuidSchema.nullable().default(null),
    stepId: uuidSchema.nullable().default(null),
    /** Required iff `kind = "mapFeature"`. A reference; the snapshot is built server-side. */
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

    // Live features are ephemeral and not in our database: no FK, the data is copied into
    // `workspace_feature_snapshots` at save time.
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
 * Reorder within one kind. `order_index` isn't unique here, but the action still rewrites the
 * list contiguously to avoid collisions on the default `0`.
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
 * Note body cap (64 KiB), a DoS limit rather than an editorial one. Notes are never parsed
 * for entities or indexed.
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

/** Editing rewrites `body` and `updated_at` only; `created_at` is never changed. */
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

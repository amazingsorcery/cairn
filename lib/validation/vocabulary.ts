import { z } from "zod";

import {
  COST_MODELS,
  CAMERA_VIEW_KINDS,
  CONFIDENCE_LEVELS,
  CONNECTOR_KINDS,
  CONNECTOR_REQUEST_OUTCOMES,
  DIFFICULTY_LEVELS,
  POLL_MODES,
  PUBLICATION_STATUSES,
  SOURCE_KINDS,
  USER_ROLES,
  WORKSPACE_ITEM_KINDS,
  WORKSPACE_STATUSES,
  type CostModel,
} from "@/db/schema";
import {
  costModels as contentCostModels,
  inputTypes as contentInputTypes,
  outputTypes as contentOutputTypes,
  type CostModel as ContentCostModel,
} from "@/lib/content/schema";

/**
 * Vocabularies. Closed ones are imported from `db/schema.ts` (CHECK-constrained) so they
 * can't drift. Open ones (`input_types`, `output_types`: unconstrained `text[]`) are
 * imported from `lib/content/schema.ts` and enforced here.
 */

/* ------------------------------------------------------------------ *
 * Closed vocabularies (CHECK-constrained in Postgres)
 * ------------------------------------------------------------------ */

export const userRoleSchema = z.enum(USER_ROLES);
export const publicationStatusSchema = z.enum(PUBLICATION_STATUSES);
export const costModelSchema = z.enum(COST_MODELS);
export const confidenceSchema = z.enum(CONFIDENCE_LEVELS);
export const difficultySchema = z.enum(DIFFICULTY_LEVELS);
export const workspaceStatusSchema = z.enum(WORKSPACE_STATUSES);
export const workspaceItemKindSchema = z.enum(WORKSPACE_ITEM_KINDS);
export const connectorKindSchema = z.enum(CONNECTOR_KINDS);

/**
 * What a source's data is about. CHECK-constrained on `workspace_feature_snapshots.source_kind`
 * and on `connectors.kind` (which also accepts the deprecated `flights`).
 */
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export const pollModeSchema = z.enum(POLL_MODES);
export const connectorOutcomeSchema = z.enum(CONNECTOR_REQUEST_OUTCOMES);
export const cameraViewKindSchema = z.enum(CAMERA_VIEW_KINDS);

/* ------------------------------------------------------------------ *
 * Open vocabularies (no database constraint — enforced here)
 * ------------------------------------------------------------------ */

export const INPUT_TYPES = contentInputTypes;
export const OUTPUT_TYPES = contentOutputTypes;

export const inputTypeSchema = z.enum(INPUT_TYPES);
export const outputTypeSchema = z.enum(OUTPUT_TYPES);

/**
 * Normalise a facet array: lowercase, trimmed, de-duplicated, sorted. Sorting keeps cache
 * keys and `search_keywords` deterministic.
 */
function facetArray<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .array(z.string())
    .transform((raw) =>
      Array.from(new Set(raw.map((v) => v.trim().toLowerCase()).filter(Boolean))).sort(),
    )
    .pipe(z.array(z.enum(values)));
}

/** Membership is enforced: an unknown facet value would be unreachable from `/directory` filters. */
export const inputTypesSchema = facetArray(INPUT_TYPES).refine(
  (v) => v.length > 0,
  "At least one input type is required",
);

export const outputTypesSchema = facetArray(OUTPUT_TYPES).refine(
  (v) => v.length > 0,
  "At least one output type is required",
);

/**
 * Same normalisation for `/directory` filters, but unknown values are dropped rather than
 * rejected, so a crafted URL can't cause an error or a new cache key.
 */
export const inputTypesFilterSchema = z
  .array(z.string())
  .transform((raw) =>
    Array.from(
      new Set(
        raw
          .map((v) => v.trim().toLowerCase())
          .filter((v): v is (typeof INPUT_TYPES)[number] =>
            (INPUT_TYPES as readonly string[]).includes(v),
          ),
      ),
    ).sort(),
  );

export const outputTypesFilterSchema = z
  .array(z.string())
  .transform((raw) =>
    Array.from(
      new Set(
        raw
          .map((v) => v.trim().toLowerCase())
          .filter((v): v is (typeof OUTPUT_TYPES)[number] =>
            (OUTPUT_TYPES as readonly string[]).includes(v),
          ),
      ),
    ).sort(),
  );

/* ------------------------------------------------------------------ *
 * Cost model
 * ------------------------------------------------------------------ */

/**
 * `costModel` is camelCase in both `db/schema.ts` and `lib/content/schema.ts`, with no
 * translation layer. Convention: closed vocabularies are camelCase (`needsReview`), open
 * `text[]` facets are kebab-case (`company-name`).
 *
 * Called by the seed script and unit tests so the two lists can't drift.
 */
export function assertCostModelsAligned(): void {
  const contentSide = [...contentCostModels].sort();
  const dbSide = [...COST_MODELS].sort();

  const missingFromDb = contentSide.filter((v) => !(dbSide as readonly string[]).includes(v));
  const missingFromContent = dbSide.filter((v) => !(contentSide as readonly string[]).includes(v));

  if (missingFromDb.length > 0 || missingFromContent.length > 0) {
    throw new Error(
      "Cost-model vocabularies have diverged. " +
        `In lib/content/schema.ts but not db/schema.ts: [${missingFromDb.join(", ")}]. ` +
        `In db/schema.ts but not lib/content/schema.ts: [${missingFromContent.join(", ")}]. ` +
        "They must be the same list, in the same spelling.",
    );
  }
}

/** Narrow a content `costModel` to the database enum, throwing on unknown values. */
export function toDbCostModel(value: ContentCostModel): CostModel {
  const parsed = costModelSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `"${value}" is not a value of COST_MODELS in db/schema.ts. ` +
        "Add it there with a CHECK-constraint migration, or fix the content.",
    );
  }
  return parsed.data;
}

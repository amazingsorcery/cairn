import { z } from "zod";

import {
  COST_MODELS,
  CAMERA_VIEW_KINDS,
  CONFIDENCE_LEVELS,
  CONNECTOR_KINDS,
  CONNECTOR_REQUEST_OUTCOMES,
  DIFFICULTY_LEVELS,
  PUBLICATION_STATUSES,
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
 * The vocabularies, in one place.
 *
 * CLOSED vocabularies come from `db/schema.ts` and carry a Postgres CHECK constraint. They
 * are imported, never retyped: a literal typed out here would drift from the constraint and
 * the drift would only surface as a 23514 at write time. HANDOFF §2.
 *
 * OPEN vocabularies — `tools.input_types` and `tools.output_types` — are plain `text[]` with
 * no constraint, so their canonical list lives in Zod. It is imported from
 * `lib/content/schema.ts` rather than restated, because the content-strategist authors
 * against that file and two lists would diverge on the first addition.
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
 * Normalise a facet array before it is stored or used as a filter: lowercase, trimmed,
 * de-duplicated, sorted. Sorting is what makes two logically identical filter tuples hash
 * to the same `unstable_cache` key (caching.md §6) and what makes `search_keywords`
 * deterministic (HANDOFF §4).
 */
function facetArray<T extends readonly [string, ...string[]]>(values: T) {
  return z
    .array(z.string())
    .transform((raw) =>
      Array.from(new Set(raw.map((v) => v.trim().toLowerCase()).filter(Boolean))).sort(),
    )
    .pipe(z.array(z.enum(values)));
}

/**
 * Membership is enforced, not merely encouraged. An unrecognised facet value stored in
 * `input_types` is invisible to every filter in `/directory` — the entry is in the
 * catalogue and unreachable by the facet that should find it, which is the quietest
 * possible content bug.
 */
export const inputTypesSchema = facetArray(INPUT_TYPES).refine(
  (v) => v.length > 0,
  "At least one input type is required",
);

export const outputTypesSchema = facetArray(OUTPUT_TYPES).refine(
  (v) => v.length > 0,
  "At least one output type is required",
);

/**
 * The same normalisation without the membership check, for the `/directory` filter path.
 *
 * A filter is dropped, never rejected: sitemap.md §1 — "Anything that fails validation is
 * dropped, not rejected — a bad filter yields the unfiltered list, never a 500." A crafted
 * URL must not be able to produce an error page or a novel cache key.
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
 * The one translation layer in the codebase, and why it exists
 * ------------------------------------------------------------------ */

/**
 * `costModel` is spelled kebab-case in authored content (`free-with-registration`) and
 * camelCase in the database (`freeWithRegistration`). `db/schema.ts` explains the split:
 * kebab reads better as a facet value in content, and camelCase is the convention for every
 * CHECK-constrained enum that code branches on.
 *
 * This map is the ONLY place the two spellings meet. It is exhaustive by construction — the
 * `Record<ContentCostModel, CostModel>` type makes a missing or misspelled member a compile
 * error rather than a `tools_cost_model_check` violation at seed time.
 */
export const CONTENT_COST_MODEL_TO_DB: Readonly<Record<ContentCostModel, CostModel>> = {
  free: "free",
  "free-with-registration": "freeWithRegistration",
  freemium: "freemium",
  paid: "paid",
  subscription: "subscription",
  enterprise: "enterprise",
};

/** Reverse map, for rendering an authored file back out of the database. */
export const DB_COST_MODEL_TO_CONTENT: Readonly<Record<CostModel, ContentCostModel>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(CONTENT_COST_MODEL_TO_DB).map(([content, database]) => [database, content]),
    ) as Record<CostModel, ContentCostModel>,
  );

/**
 * Guard against the two lists silently diverging. Called by the seed script and asserted in
 * the unit tests, so a value added to one array and not the other fails before it can write
 * a row the CHECK constraint would reject.
 */
export function assertCostModelsAligned(): void {
  const contentSide = new Set(contentCostModels);
  const dbSide = new Set<string>(COST_MODELS);

  const mapped = new Set(Object.values(CONTENT_COST_MODEL_TO_DB));
  const missingFromMap = [...contentSide].filter((v) => !(v in CONTENT_COST_MODEL_TO_DB));
  const unmappedDbValues = [...dbSide].filter((v) => !mapped.has(v as CostModel));

  if (missingFromMap.length > 0 || unmappedDbValues.length > 0) {
    throw new Error(
      "Cost-model vocabularies have diverged. " +
        `Content values with no database mapping: [${missingFromMap.join(", ")}]. ` +
        `Database values nothing maps to: [${unmappedDbValues.join(", ")}]. ` +
        "Fix lib/content/schema.ts, db/schema.ts and CONTENT_COST_MODEL_TO_DB together.",
    );
  }
}

import { z } from "zod";

import { pageSchema, searchQuerySchema, slugSchema, toArray } from "./common";
import {
  CAMERA_VIEW_KINDS,
  CONFIDENCE_LEVELS,
  COST_MODELS,
  type CameraViewKind,
} from "@/db/schema";
import { inputTypesFilterSchema, outputTypesFilterSchema } from "./vocabulary";
import { toolSortSchema } from "./tools";

/**
 * `searchParams` normalisation for `/directory`, `/search` and `/live/cameras`. Never throws:
 * invalid values are dropped, not rejected. Output is canonical (unknown keys dropped, arrays
 * sorted and de-duplicated, `page` clamped) since it keys the cache; otherwise crafted URLs
 * could flood it.
 */

/** How Next.js hands a route its query string. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Match a value against a closed vocabulary case-insensitively and return the vocabulary's
 * own spelling, or `undefined`. Don't just lowercase: values like `needsReview` are camelCase.
 */
function canonical<T extends string>(vocabulary: readonly T[], raw: string): T | undefined {
  const needle = raw.trim().toLowerCase();
  if (needle === "") return undefined;
  return vocabulary.find((member) => member.toLowerCase() === needle);
}

/** One value from a closed vocabulary, or `undefined`. */
function optionalOf<T extends string>(
  vocabulary: readonly T[],
  value: string | string[] | undefined,
): T | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return undefined;
  return canonical(vocabulary, first);
}

/** Repeated values from a closed vocabulary: de-duplicated, sorted, non-members dropped. */
function manyOf<T extends string>(
  vocabulary: readonly T[],
  value: string | string[] | undefined,
): T[] {
  const out = new Set<T>();
  for (const raw of toArray(value)) {
    const member = canonical(vocabulary, raw);
    if (member) out.add(member);
  }
  return [...out].sort();
}

/** Parse one value through a schema, lowercased. Only for always-lowercase values (slugs etc). */
function optional<T>(schema: z.ZodType<T>, value: string | string[] | undefined): T | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first.trim() === "") return undefined;
  const parsed = schema.safeParse(first.trim().toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

/** As `optional`, repeated. Slugs only, for the same reason. */
function many<T>(schema: z.ZodType<T>, value: string | string[] | undefined): T[] {
  const out = new Set<T>();
  for (const raw of toArray(value)) {
    const parsed = schema.safeParse(raw.trim().toLowerCase());
    if (parsed.success) out.add(parsed.data);
  }
  return [...out].sort();
}

export type DirectoryFilters = {
  q: string;
  category: string | undefined;
  tags: string[];
  cost: string[];
  input: string[];
  output: string[];
  confidence: string[];
  sort: z.infer<typeof toolSortSchema>;
  page: number;
};

export function parseDirectoryFilters(params: RawSearchParams): DirectoryFilters {
  const q = searchQuerySchema.catch("").parse(
    Array.isArray(params.q) ? (params.q[0] ?? "") : (params.q ?? ""),
  );

  return {
    q,
    category: optional(slugSchema, params.category),
    tags: many(slugSchema, params.tag),
    cost: manyOf(COST_MODELS, params.cost),
    input: inputTypesFilterSchema.parse(toArray(params.input)),
    output: outputTypesFilterSchema.parse(toArray(params.output)),
    confidence: manyOf(CONFIDENCE_LEVELS, params.confidence),
    // Relevance only defaults when there's a query.
    sort: q ? toolSortSchema.parse(params.sort ?? "relevance") : toolSortSchema.parse(params.sort),
    page: pageSchema.parse(Array.isArray(params.page) ? params.page[0] : params.page),
  };
}

/**
 * Cache key built from the normalised filters, not the raw query string. Readable rather
 * than hashed, for debugging; nothing in it is secret.
 */
export function directoryCacheKey(filters: DirectoryFilters): string {
  return [
    `q=${filters.q}`,
    `c=${filters.category ?? ""}`,
    `t=${filters.tags.join("|")}`,
    `m=${filters.cost.join("|")}`,
    `i=${filters.input.join("|")}`,
    `o=${filters.output.join("|")}`,
    `f=${filters.confidence.join("|")}`,
    `s=${filters.sort}`,
    `p=${filters.page}`,
  ].join(";");
}

/** `/search` spans tools and playbooks; it has a query and a page and nothing else. */
export type SearchFilters = { q: string; page: number };

export function parseSearchFilters(params: RawSearchParams): SearchFilters {
  return {
    q: searchQuerySchema
      .catch("")
      .parse(Array.isArray(params.q) ? (params.q[0] ?? "") : (params.q ?? "")),
    page: pageSchema.parse(Array.isArray(params.page) ? params.page[0] : params.page),
  };
}

export function searchCacheKey(filters: SearchFilters): string {
  return `q=${filters.q};p=${filters.page}`;
}

/** `/live/cameras` reads `jurisdiction`, `view` and `q`. */
export type CameraFilters = {
  q: string;
  jurisdiction: string | undefined;
  view: CameraViewKind | undefined;
};

export function parseCameraFilters(params: RawSearchParams): CameraFilters {
  return {
    q: searchQuerySchema
      .catch("")
      .parse(Array.isArray(params.q) ? (params.q[0] ?? "") : (params.q ?? "")),
    // Free text in the content, so bounded and character-restricted rather than enumerated.
    jurisdiction: optional(
      z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z0-9 -]+$/, "Unknown jurisdiction"),
      params.jurisdiction,
    ),
    view: optionalOf(CAMERA_VIEW_KINDS, params.view),
  };
}

export function cameraCacheKey(filters: CameraFilters): string {
  return `q=${filters.q};j=${filters.jurisdiction ?? ""};v=${filters.view ?? ""}`;
}

/** `/api/search/suggest` input. Rate limited. */
export const suggestQuerySchema = z.object({
  q: z.string().trim().min(2, "Type at least two characters").max(200),
});

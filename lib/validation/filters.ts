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
 * `searchParams` normalisation for `/directory`, `/search` and `/live/cameras`.
 *
 * TWO jobs, and the second is the one that is easy to miss.
 *
 * 1. Produce a well-typed filter set. Nothing here throws: `sitemap.md` §1 — "Anything that
 *    fails validation is dropped, not rejected — a bad filter yields the unfiltered list,
 *    never a 500." A crafted query string must not be able to render an error page.
 *
 * 2. Produce a CANONICAL filter tuple. `caching.md` §6 keys the `unstable_cache` entry on
 *    this, so `?tag=b&tag=a` and `?tag=a&tag=b&junk=1` must normalise to one key or the
 *    cache hit rate collapses and an attacker can fill the Data Cache with junk entries from
 *    crafted URLs. Hence: unknown keys dropped, arrays sorted and de-duplicated, values
 *    lowercased, `page` clamped to 1..100.
 */

/** How Next.js hands a route its query string. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Resolve one raw query-string value to its CANONICAL spelling in a closed vocabulary,
 * case-insensitively, or `undefined` if it is not a member.
 *
 * The case-insensitive match and the canonical result are both load-bearing, and getting
 * this wrong is how the bug this function was written to fix happened. The closed
 * vocabularies in `db/schema.ts` are camelCase — `needsReview`, `freeWithRegistration` —
 * because they are CHECK-constrained values that code branches on. An earlier version of
 * this file lowercased every incoming value before validating it, on the reasonable-sounding
 * grounds that a canonical cache key wants a canonical case. That silently destroyed exactly
 * those two values: `needsReview` became `needsreview`, failed `z.enum`, and was dropped. The
 * chip appeared selected in the URL and filtered nothing, with no error anywhere.
 *
 * So: fold case only for the COMPARISON, and return the vocabulary's own spelling. That
 * canonicalises `?confidence=NEEDSREVIEW` and `?confidence=needsreview` to the same filter
 * and the same cache key, while preserving the value the database actually stores.
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

/**
 * Coerce a single value through a Zod schema. Used only for the OPEN vocabularies whose
 * values are lowercase by definition — slugs, and the jurisdiction pattern — where
 * lowercasing the input is the correct normalisation rather than a destructive one.
 */
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
    /**
     * Relevance ordering is meaningless with no query, so it degrades to `name` rather than
     * producing an arbitrary order that differs between pages of the same result set.
     */
    sort: q ? toolSortSchema.parse(params.sort ?? "relevance") : toolSortSchema.parse(params.sort),
    page: pageSchema.parse(Array.isArray(params.page) ? params.page[0] : params.page),
  };
}

/**
 * The cache key. A stable, sorted, lossless string built from the normalised tuple — NOT the
 * raw query string, which would key one cache entry per parameter permutation.
 *
 * Deliberately human-readable rather than hashed: a `unstable_cache` key you can read in a
 * log is worth more than the few bytes a digest would save, and there is nothing secret in a
 * public directory filter.
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

/** `/live/cameras` reads `jurisdiction`, `view` and `q` (sitemap.md §3). */
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
    /**
     * Jurisdiction is free text on `cameras` (the content-strategist owns the value list, not
     * the schema), so it is length-bounded and character-restricted rather than enumerated.
     */
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

/** `/api/search/suggest`. One query, nothing else. Rate limited (search.md §6.5). */
export const suggestQuerySchema = z.object({
  q: z.string().trim().min(2, "Type at least two characters").max(200),
});

import type { DirectoryFilters } from "@/lib/validation/filters";

import { FACET_CHIP_PREFIX, confidenceValueLabel, costLabel, typeLabel } from "./facets";

/**
 * Builds directory URLs. All filter state lives in the URL so views are shareable and back
 * works. Pure (no React), so the server can compute every href.
 *
 * `parseDirectoryFilters(serialiseFilters(f))` must equal `f`; see `filter-url.test.ts`.
 */

/**
 * Default sort: `relevance` with a query, `name` without. Omitted from URLs to keep links
 * short and avoid duplicate `unstable_cache` entries.
 */
export function defaultSort(q: string): string {
  return q ? "relevance" : "name";
}

/** The normalised tuple as a query string, defaults omitted. Order is stable. */
export function serialiseFilters(filters: DirectoryFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  for (const value of filters.tags) params.append("tag", value);
  for (const value of filters.cost) params.append("cost", value);
  for (const value of filters.input) params.append("input", value);
  for (const value of filters.output) params.append("output", value);
  for (const value of filters.confidence) params.append("confidence", value);
  if (filters.sort !== defaultSort(filters.q)) params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));

  return params;
}

export function filtersHref(basePath: string, filters: DirectoryFilters): string {
  const query = serialiseFilters(filters).toString();
  return query ? `${basePath}?${query}` : basePath;
}

/** Filter changes reset to page 1 to avoid landing past the end of the results. */
function resetPage(filters: DirectoryFilters): DirectoryFilters {
  return { ...filters, page: 1 };
}

export type ArrayFacet = "tags" | "cost" | "input" | "output" | "confidence";

const ARRAY_FACET_PARAM: Record<ArrayFacet, string> = {
  tags: "tag",
  cost: "cost",
  input: "input",
  output: "output",
  confidence: "confidence",
};

/** Drop one value from one multi-valued facet. */
export function withoutValue(
  filters: DirectoryFilters,
  facet: ArrayFacet,
  value: string,
): DirectoryFilters {
  return resetPage({ ...filters, [facet]: filters[facet].filter((v) => v !== value) });
}

export function withoutCategory(filters: DirectoryFilters): DirectoryFilters {
  return resetPage({ ...filters, category: undefined });
}

export function withoutQuery(filters: DirectoryFilters): DirectoryFilters {
  const next = resetPage({ ...filters, q: "" });
  // The parser drops `relevance` without a query; match it so the round trip holds.
  return next.sort === "relevance" ? { ...next, sort: "name" } : next;
}

export function withPage(filters: DirectoryFilters, page: number): DirectoryFilters {
  return { ...filters, page };
}

/** Every filter cleared; serialises to a bare `/directory`. */
export function clearedFilters(): DirectoryFilters {
  return {
    q: "",
    category: undefined,
    tags: [],
    cost: [],
    input: [],
    output: [],
    confidence: [],
    sort: "name",
    page: 1,
  };
}

/**
 * One active filter for the chip row and empty state. `without` is the filters with this
 * value removed; the empty state queries each to find the widest single removal.
 */
export interface ActiveFilter {
  /** Stable key for React and for the `remove` button's accessible name. */
  id: string;
  /** `cost: free` — the prefix names which facet, so two chips can share a value. */
  label: string;
  without: DirectoryFilters;
}

export interface FilterLabelMaps {
  categoryNames: ReadonlyMap<string, string>;
  tagNames: ReadonlyMap<string, string>;
}

/**
 * Active filters in display order. Includes `q`, since removing the query is often the
 * widest removal.
 */
export function activeFilters(
  filters: DirectoryFilters,
  labels: FilterLabelMaps,
): ActiveFilter[] {
  const out: ActiveFilter[] = [];

  if (filters.q) {
    out.push({
      id: "q",
      label: `${FACET_CHIP_PREFIX.q}: ${filters.q}`,
      without: withoutQuery(filters),
    });
  }

  if (filters.category) {
    const slug = filters.category;
    out.push({
      id: `category:${slug}`,
      label: `${FACET_CHIP_PREFIX.category}: ${labels.categoryNames.get(slug) ?? slug}`,
      without: withoutCategory(filters),
    });
  }

  for (const slug of filters.tags) {
    out.push({
      id: `tag:${slug}`,
      label: `${FACET_CHIP_PREFIX.tag}: ${labels.tagNames.get(slug) ?? slug}`,
      without: withoutValue(filters, "tags", slug),
    });
  }

  for (const value of filters.cost) {
    out.push({
      id: `cost:${value}`,
      label: `${FACET_CHIP_PREFIX.cost}: ${costLabel(value)}`,
      without: withoutValue(filters, "cost", value),
    });
  }

  for (const value of filters.input) {
    out.push({
      id: `input:${value}`,
      label: `${FACET_CHIP_PREFIX.input}: ${typeLabel(value)}`,
      without: withoutValue(filters, "input", value),
    });
  }

  for (const value of filters.output) {
    out.push({
      id: `output:${value}`,
      label: `${FACET_CHIP_PREFIX.output}: ${typeLabel(value)}`,
      without: withoutValue(filters, "output", value),
    });
  }

  for (const value of filters.confidence) {
    out.push({
      id: `confidence:${value}`,
      label: `${FACET_CHIP_PREFIX.confidence}: ${confidenceValueLabel(value)}`,
      without: withoutValue(filters, "confidence", value),
    });
  }

  return out;
}

/** The facet param names a `<form method="get">` writes, for the hidden-input mirror. */
export function facetParamName(facet: ArrayFacet): string {
  return ARRAY_FACET_PARAM[facet];
}

/**
 * Filters as name/value pairs for hidden inputs. The toolbar form (`q`, `sort`) and facet
 * form each mirror the other's values so submitting one doesn't drop the other.
 */
export function hiddenPairs(
  filters: DirectoryFilters,
  omit: readonly string[],
): { name: string; value: string }[] {
  const pairs: { name: string; value: string }[] = [];
  for (const [name, value] of serialiseFilters(filters).entries()) {
    if (omit.includes(name)) continue;
    // `page` is never mirrored: a filter change always returns to page 1.
    if (name === "page") continue;
    pairs.push({ name, value });
  }
  return pairs;
}

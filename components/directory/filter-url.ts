import type { DirectoryFilters } from "@/lib/validation/filters";

import { FACET_CHIP_PREFIX, confidenceValueLabel, costLabel, typeLabel } from "./facets";

/**
 * The URL is the filter state. Nothing else is.
 *
 * `docs/design/wireframes/02-directory.txt`: "All filter state is in the URL: q, category,
 * tag, cost, input, output, confidence, sort, page. No hidden component state, so browser
 * back restores the previous filter set exactly." That is not a nicety for this audience —
 * an investigator cites what they searched, and a filtered view that cannot be pasted into
 * a note is a view that cannot be cited.
 *
 * This module is the single place a directory URL is built. It is pure and has no React and
 * no `next/navigation` import, so the server can compute every href and the client leaf only
 * has to push a string it was handed.
 *
 * Round-tripping rule: `parseDirectoryFilters(serialise(f))` must equal `f`. The tests in
 * `components/directory/filter-url.test.ts` assert it, because a serialiser that disagrees
 * with the parser produces a "clear all" button that does not clear.
 */

/**
 * `parseDirectoryFilters` defaults `sort` to `relevance` when a query is present and to
 * `name` when it is not. Omitting the default from the URL keeps a shareable link short and
 * keeps one `unstable_cache` entry rather than two for the same result set.
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

/**
 * Any change to *what* is being asked for returns the reader to page 1. Keeping the page
 * number across a filter change lands them on an empty page 4 of a 2-page result set, which
 * looks exactly like a broken filter.
 */
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
  // `sort: relevance` is meaningless with no query and `parseDirectoryFilters` would drop it
  // back to `name` anyway. Doing it here keeps the serialised URL and the parsed tuple equal.
  return next.sort === "relevance" ? { ...next, sort: "name" } : next;
}

export function withPage(filters: DirectoryFilters, page: number): DirectoryFilters {
  return { ...filters, page };
}

/** Every filter cleared. `docs/design/states.md` §2.1: this returns to a bare `/directory`. */
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
 * One active filter, as the chip row and the zero-result state need it.
 *
 * `without` is the whole filter tuple with this one value dropped — the empty state calls
 * `listTools()` with each of these to find which single removal widens the result set most,
 * so the sentence in `states.md` §2.1 names a computed filter and never a guessed one.
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
 * The active filters, in the order the wireframe draws them. `q` is included: it restricts
 * the result set exactly as a facet does, and on a zero-result page it is frequently the
 * single removal that widens things most. Leaving it out of this list would make the
 * "removing X widens this the most" sentence wrong whenever the query was the culprit.
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
 * Every filter as `[name, value]` pairs, for mirroring the current state into a form that
 * only owns part of it. The toolbar form owns `q` and `sort`; the facet form owns the
 * checkboxes; each must carry the other's values or submitting one would silently discard
 * the other.
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

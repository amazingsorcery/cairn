import { describe, expect, it } from "vitest";

import { parseDirectoryFilters, type DirectoryFilters } from "@/lib/validation/filters";
import { CONFIDENCE_LEVELS, COST_MODELS } from "@/db/schema";

import {
  activeFilters,
  clearedFilters,
  filtersHref,
  hiddenPairs,
  serialiseFilters,
  withPage,
  withoutCategory,
  withoutQuery,
  withoutValue,
} from "./filter-url";

/**
 * The round-trip contract.
 *
 * `/directory` keeps ALL of its state in the URL so a filtered view is citable and the
 * browser's back button restores the previous set exactly (`wireframes/02-directory.txt`).
 * That only holds if the serialiser in `filter-url.ts` and the parser in
 * `lib/validation/filters.ts` agree. When they do not, the visible symptom is a "clear all"
 * that does not clear or a chip that refuses to be removed, and nothing in the type system
 * catches it — hence these tests.
 */

/** Feed a serialised query string back through the real parser, as Next.js would. */
function roundTrip(filters: DirectoryFilters): DirectoryFilters {
  const params = serialiseFilters(filters);
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    raw[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return parseDirectoryFilters(raw);
}

const EMPTY = clearedFilters();

describe("serialiseFilters", () => {
  it("produces a bare path for the default view", () => {
    expect(serialiseFilters(EMPTY).toString()).toBe("");
    expect(filtersHref("/directory", EMPTY)).toBe("/directory");
  });

  it("omits the sort default, which differs with and without a query", () => {
    // No query: the parser's default is `name`.
    expect(serialiseFilters({ ...EMPTY, sort: "name" }).has("sort")).toBe(false);
    expect(serialiseFilters({ ...EMPTY, sort: "recent" }).get("sort")).toBe("recent");

    // With a query: the parser's default is `relevance`, so `relevance` is the one omitted.
    expect(serialiseFilters({ ...EMPTY, q: "shodan", sort: "relevance" }).has("sort")).toBe(false);
    expect(serialiseFilters({ ...EMPTY, q: "shodan", sort: "name" }).get("sort")).toBe("name");
  });

  it("omits page 1", () => {
    expect(serialiseFilters(EMPTY).has("page")).toBe(false);
    expect(serialiseFilters(withPage(EMPTY, 3)).get("page")).toBe("3");
  });

  it("repeats multi-valued facets under one key", () => {
    const params = serialiseFilters({ ...EMPTY, cost: ["free", "freemium"] });
    expect(params.getAll("cost")).toEqual(["free", "freemium"]);
  });
});

describe("round trip through parseDirectoryFilters", () => {
  it("survives a fully populated filter set", () => {
    const filters: DirectoryFilters = {
      q: "certificate transparency",
      category: "domain-and-infrastructure",
      tags: ["archive", "free"],
      cost: ["free", "freemium"],
      input: ["domain", "url"],
      output: ["records"],
      confidence: ["high", "verified"],
      sort: "reliability",
      page: 4,
    };
    expect(roundTrip(filters)).toEqual(filters);
  });

  it("survives the empty set", () => {
    expect(roundTrip(EMPTY)).toEqual(EMPTY);
  });

  it("survives every single-facet view", () => {
    const singles: DirectoryFilters[] = [
      { ...EMPTY, q: "shodan", sort: "relevance" },
      { ...EMPTY, category: "threat-intelligence" },
      { ...EMPTY, tags: ["osint"] },
      { ...EMPTY, cost: ["enterprise"] },
      { ...EMPTY, input: ["image"] },
      { ...EMPTY, output: ["none"] },
      { ...EMPTY, confidence: ["needsReview"] },
      withPage(EMPTY, 7),
    ];
    for (const filters of singles) {
      expect(roundTrip(filters)).toEqual(filters);
    }
  });
});

describe("removing one filter", () => {
  const busy: DirectoryFilters = {
    q: "shodan",
    category: "threat-intelligence",
    tags: ["osint"],
    cost: ["free"],
    input: ["domain"],
    output: [],
    confidence: ["verified"],
    sort: "relevance",
    page: 5,
  };

  it("drops exactly one value and returns to page 1", () => {
    const next = withoutValue(busy, "cost", "free");
    expect(next.cost).toEqual([]);
    expect(next.page).toBe(1);
    // Nothing else moved.
    expect(next.confidence).toEqual(["verified"]);
    expect(next.category).toBe("threat-intelligence");
  });

  it("drops the category without touching the facets", () => {
    const next = withoutCategory(busy);
    expect(next.category).toBeUndefined();
    expect(next.tags).toEqual(["osint"]);
    expect(next.page).toBe(1);
  });

  it("degrades relevance sort to name when the query goes", () => {
    // `relevance` is meaningless with no query and `parseDirectoryFilters` would drop it, so
    // the serialised URL and the parsed tuple must agree before the link is even rendered.
    const next = withoutQuery(busy);
    expect(next.q).toBe("");
    expect(next.sort).toBe("name");
    expect(roundTrip(next)).toEqual(next);
  });

  it("clears everything back to a bare /directory", () => {
    expect(filtersHref("/directory", clearedFilters())).toBe("/directory");
  });
});

describe("activeFilters", () => {
  const labels = {
    categoryNames: new Map([["threat-intelligence", "Threat Intelligence"]]),
    tagNames: new Map([["osint", "OSINT"]]),
  };

  it("lists every active filter, query included, with a prefixed label", () => {
    const chips = activeFilters(
      {
        ...EMPTY,
        q: "shodan",
        category: "threat-intelligence",
        tags: ["osint"],
        cost: ["free"],
        confidence: ["needsReview"],
        sort: "relevance",
      },
      labels,
    );

    expect(chips.map((chip) => chip.label)).toEqual([
      "name: shodan",
      "category: Threat Intelligence",
      "tag: OSINT",
      "cost: free",
      "confidence: needs review",
    ]);
  });

  it("gives each chip a tuple with only that filter removed", () => {
    const chips = activeFilters({ ...EMPTY, cost: ["free", "paid"] }, labels);
    expect(chips).toHaveLength(2);
    expect(chips[0]?.without.cost).toEqual(["paid"]);
    expect(chips[1]?.without.cost).toEqual(["free"]);
  });

  it("is empty when nothing is filtered", () => {
    expect(activeFilters(EMPTY, labels)).toEqual([]);
  });
});

describe("hiddenPairs", () => {
  const filters: DirectoryFilters = {
    ...EMPTY,
    q: "shodan",
    category: "threat-intelligence",
    cost: ["free"],
    sort: "name",
    page: 3,
  };

  it("mirrors the facets for the toolbar form, which owns q and sort", () => {
    expect(hiddenPairs(filters, ["q", "sort"])).toEqual([
      { name: "category", value: "threat-intelligence" },
      { name: "cost", value: "free" },
    ]);
  });

  it("mirrors q and sort for the facet form, which owns the facets", () => {
    expect(hiddenPairs(filters, ["category", "tag", "cost", "input", "output", "confidence"])).toEqual([
      { name: "q", value: "shodan" },
      { name: "sort", value: "name" },
    ]);
  });

  it("never mirrors page — a filter change always returns to page 1", () => {
    const mirrored = hiddenPairs(filters, []);
    expect(mirrored.some((pair) => pair.name === "page")).toBe(false);
  });
});

/**
 * THE CAMELCASE VOCABULARY CONTRACT.
 *
 * `COST_MODELS` and `CONFIDENCE_LEVELS` are camelCase in `db/schema.ts` (ADR 0004:
 * CHECK-constrained vocabularies that code branches on are camelCase). A `searchParams`
 * normaliser that lowercases values before validating them destroys `needsReview` and
 * `freeWithRegistration` — and destroys them SILENTLY, because `sitemap.md` §1 requires a bad
 * filter to be dropped rather than rejected. The chip reads as selected in the URL and filters
 * nothing.
 *
 * That is not a cosmetic loss. `needsReview` is the one confidence level a reader most needs
 * to isolate, and `freeWithRegistration` is a threat-model tier: it means the operator learns
 * who you are before you get a result.
 *
 * This was a live bug, found by the round-trip tests above and fixed in
 * `lib/validation/filters.ts` by folding case only for the COMPARISON and returning the
 * vocabulary's own spelling. These assert the OUTCOME the directory depends on rather than the
 * shape of the fix, so they keep guarding it. See `docs/frontend/HANDOFF-directory.md`.
 */
describe("every closed-vocabulary value survives a round trip through the URL", () => {
  it("keeps every confidence level, camelCase included", () => {
    for (const level of CONFIDENCE_LEVELS) {
      expect(parseDirectoryFilters({ confidence: level }).confidence).toEqual([level]);
    }
  });

  it("keeps every cost model, camelCase included", () => {
    for (const model of COST_MODELS) {
      expect(parseDirectoryFilters({ cost: model }).cost).toEqual([model]);
    }
  });

  it("keeps the result sorted and de-duplicated, so the cache key stays canonical", () => {
    expect(parseDirectoryFilters({ cost: ["freemium", "free", "free"] }).cost).toEqual([
      "free",
      "freemium",
    ]);
  });

  it("admits nothing outside the vocabulary", () => {
    expect(parseDirectoryFilters({ confidence: "gold-plated" }).confidence).toEqual([]);
    expect(parseDirectoryFilters({ cost: "priceless" }).cost).toEqual([]);
  });

  it("round-trips a needsReview filter through serialise and parse", () => {
    const filters = { ...EMPTY, confidence: ["needsReview"] };
    expect(roundTrip(filters)).toEqual(filters);
    expect(filtersHref("/directory", filters)).toBe("/directory?confidence=needsReview");
  });
});

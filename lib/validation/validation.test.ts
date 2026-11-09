import { describe, expect, it } from "vitest";

import { COST_MODELS, CONFIDENCE_LEVELS, WORKSPACE_ITEM_KINDS } from "@/db/schema";
import { costModels as contentCostModels } from "@/lib/content/schema";

import { SUMMARY_MAX, summarySchema, uuidSchema } from "./common";
import { directoryCacheKey, parseDirectoryFilters, parseSearchFilters } from "./filters";
import { checkContiguousOrder, replacePlaybookStepsSchema } from "./playbooks";
import { assertCostModelsAligned, inputTypesSchema, outputTypesSchema } from "./vocabulary";
import {
  addWorkspaceItemSchema,
  createNoteSchema,
  NOTE_MAX,
  packSnapshotProperties,
  savedFeatureSchema,
  unpackSnapshotProperties,
} from "./workspaces";

const UUID = "0f8f7c2e-2f7a-4d1a-9c1e-6d1b0a0c2f3d";
const UUID_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("vocabulary alignment", () => {
  it("keeps COST_MODELS and the content cost models identical", () => {
    // One spelling, no translation layer.
    expect(() => assertCostModelsAligned()).not.toThrow();
    expect([...contentCostModels].sort()).toEqual([...COST_MODELS].sort());
  });

  it("stores confidence in camelCase, never hyphenated", () => {
    expect(CONFIDENCE_LEVELS).toContain("needsReview");
    expect(CONFIDENCE_LEVELS as readonly string[]).not.toContain("needs-review");
  });
});

describe("facet vocabularies", () => {
  it("normalises, de-duplicates and sorts", () => {
    expect(inputTypesSchema.parse([" Domain ", "domain", "EMAIL"])).toEqual(["domain", "email"]);
  });

  it("rejects a value outside the vocabulary", () => {
    // Postgres wouldn't reject it (text[]), but filters could never reach it.
    expect(inputTypesSchema.safeParse(["domain", "smoke-signal"]).success).toBe(false);
  });

  it("requires at least one value on each side", () => {
    expect(inputTypesSchema.safeParse([]).success).toBe(false);
    expect(outputTypesSchema.safeParse([]).success).toBe(false);
  });

  it("accepts 'none' as a real output type", () => {
    // Tradecraft and OPSEC entries protect the investigator rather than yielding evidence.
    expect(outputTypesSchema.parse(["none"])).toEqual(["none"]);
  });
});

describe("summary length", () => {
  it("accepts a summary at the ceiling and rejects one over it", () => {
    expect(summarySchema.safeParse("x".repeat(SUMMARY_MAX)).success).toBe(true);
    expect(summarySchema.safeParse("x".repeat(SUMMARY_MAX + 1)).success).toBe(false);
  });

  it("trims before measuring", () => {
    expect(summarySchema.parse(`  ${"x".repeat(SUMMARY_MAX)}  `)).toHaveLength(SUMMARY_MAX);
  });
});

describe("uuid", () => {
  it("rejects a non-uuid route param rather than letting it reach the driver", () => {
    // Otherwise Postgres raises 22P02 (a 500 instead of a 404).
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(uuidSchema.safeParse("'; drop table tools; --").success).toBe(false);
    expect(uuidSchema.safeParse(UUID).success).toBe(true);
  });
});

describe("workspace item kind/reference pairing", () => {
  // No CHECK constraint (it would conflict with ON DELETE SET NULL), so Zod is the only enforcement.
  it("covers every kind in the vocabulary", () => {
    expect([...WORKSPACE_ITEM_KINDS]).toEqual(["tool", "checklistStep", "mapFeature"]);
  });

  it("requires a feature reference for kind 'mapFeature', and neither FK", () => {
    // Live features are ephemeral, so they're snapshotted rather than referenced by FK.
    const feature = { sourceSlug: "usgs-earthquakes", featureRef: "us7000abcd" };

    expect(
      addWorkspaceItemSchema.safeParse({
        workspaceId: UUID,
        kind: "mapFeature",
        feature,
      }).success,
    ).toBe(true);

    expect(
      addWorkspaceItemSchema.safeParse({ workspaceId: UUID, kind: "mapFeature" }).success,
    ).toBe(false);

    // Neither FK may be set.
    expect(
      addWorkspaceItemSchema.safeParse({
        workspaceId: UUID,
        kind: "mapFeature",
        feature,
        toolId: UUID,
      }).success,
    ).toBe(false);
  });

  it("gives a crafted request no field in which to send an attribution", () => {
    // The server supplies attribution, licence, source name and title; only the reference
    // survives parsing.
    const parsed = addWorkspaceItemSchema.parse({
      workspaceId: UUID,
      kind: "mapFeature",
      feature: {
        sourceSlug: "usgs-earthquakes",
        featureRef: "us7000abcd",
        attribution: " ",
        licence: "",
        sourceName: "Totally Made Up Observatory",
        latitude: 0,
        longitude: 0,
        observedAt: "1970-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.feature).toEqual({
      sourceSlug: "usgs-earthquakes",
      featureRef: "us7000abcd",
    });
  });

  it("refuses a whitespace attribution or licence on the way to the database", () => {
    // Licences like ODbL and CC BY require the credit, so whitespace-only must fail.
    const snapshot = {
      sourceSlug: "usgs-earthquakes",
      sourceName: "USGS Earthquake Hazards Program",
      sourceKind: "earthquakes",
      featureRef: "us7000abcd",
      label: "M 4.6 - 12 km SW of Petrolia",
      latitude: 38.1,
      longitude: -122.4,
      observedAt: "2026-08-31T12:00:00.000Z",
      attribution: "USGS Earthquake Hazards Program",
      licence: "public domain (US Government)",
    };

    expect(savedFeatureSchema.safeParse(snapshot).success).toBe(true);
    expect(savedFeatureSchema.safeParse({ ...snapshot, attribution: " " }).success).toBe(false);
    expect(savedFeatureSchema.safeParse({ ...snapshot, licence: "\t\n " }).success).toBe(false);
    expect(savedFeatureSchema.safeParse({ ...snapshot, label: "  " }).success).toBe(false);
    expect(savedFeatureSchema.safeParse({ ...snapshot, sourceName: "" }).success).toBe(false);
  });

  it("carries the precision caveat through the properties column and back", () => {
    // No `precision` column, so the caveat rides in `properties`.
    const packed = packSnapshotProperties(
      { event: "Flood Warning", severity: "Severe" },
      {
        label: "approx - zone centre",
        note: "This alert names administrative zones rather than a polygon, so the coordinate is the centre of one zone.",
        approximateRadiusMetres: 30000,
      },
    );

    // Adapter properties stay at the top level.
    expect(packed.event).toBe("Flood Warning");

    const unpacked = unpackSnapshotProperties(packed);
    expect(unpacked.properties).toEqual({ event: "Flood Warning", severity: "Severe" });
    expect(unpacked.precision?.approximateRadiusMetres).toBe(30000);
    expect(unpacked.precision?.label).toBe("approx - zone centre");

    // No caveat means null, not an empty one.
    expect(unpackSnapshotProperties(packSnapshotProperties({ a: 1 }, null)).precision).toBeNull();
    // Old or malformed rows.
    expect(unpackSnapshotProperties(null)).toEqual({ properties: {}, precision: null });
    expect(unpackSnapshotProperties({ $precision: "nonsense" }).precision).toBeNull();
  });

  it("requires toolId for kind 'tool'", () => {
    expect(
      addWorkspaceItemSchema.safeParse({ workspaceId: UUID, kind: "tool", toolId: UUID_B }).success,
    ).toBe(true);
    expect(addWorkspaceItemSchema.safeParse({ workspaceId: UUID, kind: "tool" }).success).toBe(
      false,
    );
  });

  it("requires stepId for kind 'checklistStep'", () => {
    expect(
      addWorkspaceItemSchema.safeParse({ workspaceId: UUID, kind: "checklistStep", stepId: UUID_B })
        .success,
    ).toBe(true);
    expect(
      addWorkspaceItemSchema.safeParse({ workspaceId: UUID, kind: "checklistStep" }).success,
    ).toBe(false);
  });

  it("rejects an item that references both a tool and a step", () => {
    expect(
      addWorkspaceItemSchema.safeParse({
        workspaceId: UUID,
        kind: "tool",
        toolId: UUID_B,
        stepId: UUID,
      }).success,
    ).toBe(false);
  });

  it("never accepts a client-supplied title", () => {
    // Titles are read server-side from tools.name / playbook_steps.title.
    const parsed = addWorkspaceItemSchema.parse({
      workspaceId: UUID,
      kind: "tool",
      toolId: UUID_B,
      title: "whatever I like",
    });
    expect(parsed).not.toHaveProperty("title");
  });
});

describe("playbook step ordering", () => {
  it("accepts contiguous 0-based order", () => {
    expect(checkContiguousOrder([0, 1, 2, 3])).toEqual([]);
    expect(checkContiguousOrder([2, 0, 1])).toEqual([]);
    expect(checkContiguousOrder([])).toEqual([]);
  });

  it("rejects 1-based order", () => {
    // Content numbers steps from 1; order_index is 0-based.
    expect(checkContiguousOrder([1, 2, 3])).toHaveLength(1);
  });

  it("rejects a gap", () => {
    expect(checkContiguousOrder([0, 1, 3])).toHaveLength(1);
  });

  it("rejects a duplicate", () => {
    // The DB catches this at commit too; this gives a field-level error.
    expect(checkContiguousOrder([0, 1, 1])).toHaveLength(1);
  });

  it("rejects a negative index", () => {
    expect(checkContiguousOrder([-1, 0, 1])).toHaveLength(1);
  });

  const step = (orderIndex: number) => ({
    orderIndex,
    title: "Preserve the image",
    objective: "Create an unaltered working copy before anything else touches it.",
    body: "Download the largest available version and hash it immediately with sha256sum.",
    doneWhen: "You hold an original-quality file and a hash of it, with a collection time.",
  });

  it("enforces contiguity through the whole-list schema", () => {
    expect(
      replacePlaybookStepsSchema.safeParse({ playbookId: UUID, steps: [step(0), step(1)] }).success,
    ).toBe(true);
    expect(
      replacePlaybookStepsSchema.safeParse({ playbookId: UUID, steps: [step(1), step(2)] }).success,
    ).toBe(false);
  });

  it("refuses a one-step playbook", () => {
    expect(
      replacePlaybookStepsSchema.safeParse({ playbookId: UUID, steps: [step(0)] }).success,
    ).toBe(false);
  });
});

describe("notes", () => {
  it("rejects an empty note and a paste bomb", () => {
    expect(createNoteSchema.safeParse({ workspaceId: UUID, body: "   " }).success).toBe(false);
    expect(
      createNoteSchema.safeParse({ workspaceId: UUID, body: "x".repeat(NOTE_MAX + 1) }).success,
    ).toBe(false);
  });

  it("allows a note with no anchor", () => {
    const parsed = createNoteSchema.parse({ workspaceId: UUID, body: "A thought." });
    expect(parsed.workspaceItemId).toBeNull();
    expect(parsed.playbookStepId).toBeNull();
  });
});

describe("filter normalisation", () => {
  it("drops unknown values instead of erroring", () => {
    // A bad filter yields the unfiltered list, never a 500.
    const filters = parseDirectoryFilters({
      cost: ["free", "unicorn"],
      input: ["domain", "smoke-signal"],
      confidence: ["verified", "totally-sure"],
      nonsense: "x",
    });
    expect(filters.cost).toEqual(["free"]);
    expect(filters.input).toEqual(["domain"]);
    expect(filters.confidence).toEqual(["verified"]);
  });

  it("produces the same cache key regardless of parameter order or duplication", () => {
    // Otherwise each permutation would mint a new cache entry.
    const a = directoryCacheKey(parseDirectoryFilters({ tag: ["b", "a"], cost: ["free"] }));
    const b = directoryCacheKey(
      parseDirectoryFilters({ tag: ["a", "b", "a"], cost: ["FREE"], junk: "1" }),
    );
    expect(a).toBe(b);
  });

  it("clamps page to 1..100", () => {
    expect(parseDirectoryFilters({ page: "0" }).page).toBe(1);
    expect(parseDirectoryFilters({ page: "-5" }).page).toBe(1);
    expect(parseDirectoryFilters({ page: "9999" }).page).toBe(100);
    expect(parseDirectoryFilters({ page: "banana" }).page).toBe(1);
    expect(parseDirectoryFilters({}).page).toBe(1);
  });

  it("bounds the query string", () => {
    expect(parseSearchFilters({ q: "x".repeat(5000) }).q).toBe("");
    expect(parseSearchFilters({ q: "  certificate transparency " }).q).toBe(
      "certificate transparency",
    );
  });

  /** Case is folded only for comparison; camelCase values like `needsReview` must survive. */
  it("keeps every closed-vocabulary value, camelCase included", () => {
    for (const level of CONFIDENCE_LEVELS) {
      expect(parseDirectoryFilters({ confidence: level }).confidence).toEqual([level]);
    }
    for (const model of COST_MODELS) {
      expect(parseDirectoryFilters({ cost: model }).cost).toEqual([model]);
    }
  });

  it("matches a vocabulary value case-insensitively and returns the canonical spelling", () => {
    // Both spellings canonicalise to the stored value and one cache key.
    expect(parseDirectoryFilters({ confidence: "NEEDSREVIEW" }).confidence).toEqual([
      "needsReview",
    ]);
    expect(parseDirectoryFilters({ confidence: "needsreview" }).confidence).toEqual([
      "needsReview",
    ]);
    expect(parseDirectoryFilters({ cost: " FreeWithRegistration " }).cost).toEqual([
      "freeWithRegistration",
    ]);
    expect(
      directoryCacheKey(parseDirectoryFilters({ confidence: "NEEDSREVIEW" })),
    ).toBe(directoryCacheKey(parseDirectoryFilters({ confidence: "needsReview" })));
  });

  it("still admits nothing outside the vocabulary", () => {
    expect(parseDirectoryFilters({ confidence: "gold-plated" }).confidence).toEqual([]);
    expect(parseDirectoryFilters({ cost: "priceless" }).cost).toEqual([]);
    expect(parseDirectoryFilters({ cost: "needsReview" }).cost).toEqual([]);
  });

  it("defaults sort to relevance only when there is a query", () => {
    expect(parseDirectoryFilters({ q: "shodan" }).sort).toBe("relevance");
    expect(parseDirectoryFilters({}).sort).toBe("name");
    expect(parseDirectoryFilters({ sort: "nonsense" }).sort).toBe("name");
  });
});

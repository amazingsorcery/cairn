import { describe, expect, it } from "vitest";

import { COST_MODELS, CONFIDENCE_LEVELS, WORKSPACE_ITEM_KINDS } from "@/db/schema";
import { costModels as contentCostModels } from "@/lib/content/schema";

import { SUMMARY_MAX, summarySchema, uuidSchema } from "./common";
import { directoryCacheKey, parseDirectoryFilters, parseSearchFilters } from "./filters";
import { checkContiguousOrder, replacePlaybookStepsSchema } from "./playbooks";
import { assertCostModelsAligned, inputTypesSchema, outputTypesSchema } from "./vocabulary";
import { addWorkspaceItemSchema, createNoteSchema, NOTE_MAX } from "./workspaces";

const UUID = "0f8f7c2e-2f7a-4d1a-9c1e-6d1b0a0c2f3d";
const UUID_B = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("vocabulary alignment", () => {
  it("keeps COST_MODELS and the content cost models identical", () => {
    // product-brief §6.2: one spelling, no translation layer. This is the regression test
    // for the drift that would otherwise surface as a tools_cost_model_check violation
    // half-way through a seed run.
    expect(() => assertCostModelsAligned()).not.toThrow();
    expect([...contentCostModels].sort()).toEqual([...COST_MODELS].sort());
  });

  it("stores confidence in camelCase, never hyphenated", () => {
    // HANDOFF §11 assertion 10.
    expect(CONFIDENCE_LEVELS).toContain("needsReview");
    expect(CONFIDENCE_LEVELS as readonly string[]).not.toContain("needs-review");
  });
});

describe("facet vocabularies", () => {
  it("normalises, de-duplicates and sorts", () => {
    expect(inputTypesSchema.parse([" Domain ", "domain", "EMAIL"])).toEqual(["domain", "email"]);
  });

  it("rejects a value outside the vocabulary", () => {
    // An unrecognised facet is stored happily by Postgres (text[] has no constraint) and is
    // then invisible to every /directory filter — the quietest possible content bug.
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
    // An invalid uuid in a WHERE clause is a Postgres 22P02, i.e. a 500 where the correct
    // answer is a 404.
    expect(uuidSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(uuidSchema.safeParse("'; drop table tools; --").success).toBe(false);
    expect(uuidSchema.safeParse(UUID).success).toBe(true);
  });
});

describe("workspace item kind/reference pairing", () => {
  // HANDOFF §3: no CHECK constraint exists for this, and adding one would break ADR 0008's
  // ON DELETE SET NULL. Zod is the only enforcement, so it is tested exhaustively.
  it("covers every kind in the vocabulary", () => {
    expect([...WORKSPACE_ITEM_KINDS]).toEqual(["tool", "checklistStep"]);
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
    // ADR 0008: the snapshot records what the user saw, so it is read server-side from
    // tools.name / playbook_steps.title. A client-supplied title records what the client said.
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
    // The seed script's translation target. content playbooks number steps from 1;
    // playbook_steps.order_index is 0-based.
    expect(checkContiguousOrder([1, 2, 3])).toHaveLength(1);
  });

  it("rejects a gap", () => {
    expect(checkContiguousOrder([0, 1, 3])).toHaveLength(1);
  });

  it("rejects a duplicate", () => {
    // The DEFERRABLE unique constraint catches this at commit; catching it here names the
    // field instead of quoting playbook_steps_playbook_order_uniq.
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
    // sitemap.md §1: a bad filter yields the unfiltered list, never a 500.
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
    // caching.md §6: without this, a crafted URL mints a new Data Cache entry per
    // permutation and the hit rate collapses.
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

  it("defaults sort to relevance only when there is a query", () => {
    expect(parseDirectoryFilters({ q: "shodan" }).sort).toBe("relevance");
    expect(parseDirectoryFilters({}).sort).toBe("name");
    expect(parseDirectoryFilters({ sort: "nonsense" }).sort).toBe("name");
  });
});

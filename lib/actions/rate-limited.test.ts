import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_ACTIONS, RATE_LIMIT_POLICIES } from "@/lib/rate-limit";

/**
 * Regression guard for QA finding Q-11.
 *
 * Five of the ten workspace actions consumed no rate-limit budget — including both deletes
 * and `reorderWorkspaceItems`, which opens a transaction and rewrites an entire list. The
 * omission was invisible because nothing said it was wrong: the file's own header described
 * four steps and never mentioned limiting, so the gap read as a decision rather than a slip.
 *
 * This test reads the source rather than calling the actions, because calling them needs a
 * session and a database — and because the property under test is structural: EVERY exported
 * action consumes a budget. A test per action would pass while a newly added eleventh action
 * slipped through, which is exactly how the first five got in.
 */

const ACTIONS_DIR = join(process.cwd(), "lib", "actions");

function exportedActions(file: string): { source: string; names: string[] } {
  const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
  const names = [...source.matchAll(/export async function (\w+)\(/g)].map((m) => m[1] as string);
  return { source, names };
}

/**
 * The body of one exported action, from its signature to the start of the next export. Crude
 * but sufficient: these files are a flat list of top-level `export async function`s.
 */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("every workspace action consumes a rate-limit budget", () => {
  const { source, names } = exportedActions("workspaces.ts");

  it("finds all ten actions", () => {
    expect(names).toHaveLength(10);
  });

  it.each([
    "createWorkspace",
    "updateWorkspace",
    "deleteWorkspace",
    "addWorkspaceItem",
    "toggleWorkspaceItem",
    "removeWorkspaceItem",
    "reorderWorkspaceItems",
    "createNote",
    "updateNote",
    "deleteNote",
  ])("%s consumes a budget", (name) => {
    expect(bodyOf(source, name)).toMatch(/consumeSafely\(/);
  });

  it("covers every exported action, not just the ten named above", () => {
    // Catches an eleventh action added later without a limit — the failure mode that let
    // the original five through.
    for (const name of names) {
      expect(bodyOf(source, name), `${name} consumes no rate-limit budget`).toMatch(
        /consumeSafely\(/,
      );
    }
  });

  it("checks the budget before touching the database", () => {
    // A limiter that runs after the write has already happened is decoration.
    for (const name of names) {
      const body = bodyOf(source, name);
      const limit = body.indexOf("consumeSafely(");
      const write = Math.min(
        ...["db.transaction(", "db.insert(", "db.update(", "db.delete("]
          .map((needle) => body.indexOf(needle))
          .filter((index) => index >= 0),
      );
      if (Number.isFinite(write)) {
        expect(limit, `${name} writes before it consumes a budget`).toBeLessThan(write);
      }
    }
  });
});

describe("the export bucket exists (Q-10)", () => {
  it("is a member of the closed action vocabulary", () => {
    expect(RATE_LIMIT_ACTIONS).toContain("workspace-export");
  });

  it("is far tighter than the ordinary write buckets", () => {
    // pdfkit runs in-process and was measured at 0.7–10.7 s per call on a box that also runs
    // Postgres and Caddy. It cannot share a budget with a checkbox toggle.
    const exportPolicy = RATE_LIMIT_POLICIES["workspace-export"];
    expect(exportPolicy.limit).toBeLessThanOrEqual(10);
    expect(exportPolicy.limit).toBeLessThan(RATE_LIMIT_POLICIES["workspace-write"].limit / 5);
  });

  it("is consumed after the ownership check, so it is not an existence oracle", () => {
    // Limiting before the ownership check would let a caller distinguish "not yours" from
    // "throttled" and learn that a guessed workspace id is real.
    const route = readFileSync(
      join(process.cwd(), "app", "workspaces", "[id]", "export", "route.ts"),
      "utf8",
    );
    expect(route.indexOf("getWorkspaceForExport(")).toBeLessThan(
      route.indexOf('consumeSafely("workspace-export"'),
    );
  });
});

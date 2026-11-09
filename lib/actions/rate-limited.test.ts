import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_ACTIONS, RATE_LIMIT_POLICIES } from "@/lib/rate-limit";

/**
 * Every exported workspace action must consume a rate-limit budget. Reads the source rather
 * than calling the actions (no session or DB needed) and covers newly added actions too.
 */

const ACTIONS_DIR = join(process.cwd(), "lib", "actions");

function exportedActions(file: string): { source: string; names: string[] } {
  const source = readFileSync(join(ACTIONS_DIR, file), "utf8");
  const names = [...source.matchAll(/export async function (\w+)\(/g)].map((m) => m[1] as string);
  return { source, names };
}

/** Source of one exported action, up to the next export. Assumes a flat list of exports. */
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
    // Catches actions added later without a limit.
    for (const name of names) {
      expect(bodyOf(source, name), `${name} consumes no rate-limit budget`).toMatch(
        /consumeSafely\(/,
      );
    }
  });

  it("checks the budget before touching the database", () => {
    // Limiting after the write would be pointless.
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

describe("the export bucket exists", () => {
  it("is a member of the closed action vocabulary", () => {
    expect(RATE_LIMIT_ACTIONS).toContain("workspace-export");
  });

  it("is far tighter than the ordinary write buckets", () => {
    // PDF export runs in-process and can take seconds per call.
    const exportPolicy = RATE_LIMIT_POLICIES["workspace-export"];
    expect(exportPolicy.limit).toBeLessThanOrEqual(10);
    expect(exportPolicy.limit).toBeLessThan(RATE_LIMIT_POLICIES["workspace-write"].limit / 5);
  });

  it("is consumed after the ownership check, so it is not an existence oracle", () => {
    // Otherwise "throttled" vs "not found" would reveal whether a guessed id exists.
    const route = readFileSync(
      join(process.cwd(), "app", "workspaces", "[id]", "export", "route.ts"),
      "utf8",
    );
    expect(route.indexOf("getWorkspaceForExport(")).toBeLessThan(
      route.indexOf('consumeSafely("workspace-export"'),
    );
  });
});

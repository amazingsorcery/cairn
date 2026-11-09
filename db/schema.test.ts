import { describe, expect, it } from "vitest";

import {
  CONNECTOR_KINDS,
  POLL_MODES,
  SOURCE_KINDS,
  WORKSPACE_ITEM_KINDS,
  workspaceFeatureSnapshots,
} from "@/db/schema";
import { SOURCE_KINDS as ADAPTER_SOURCE_KINDS } from "@/lib/sources/types";

/**
 * Guards against drift between duplicated vocabularies (TS arrays vs. the CHECK constraints
 * rendered from them). No DB connection; constraint checks live in `scripts/verify-db.ts`.
 */

describe("source kind vocabulary", () => {
  /** The schema keeps its own copy of SOURCE_KINDS; this keeps the two in sync. */
  it("mirrors lib/sources/types.ts value for value, in order", () => {
    expect([...SOURCE_KINDS]).toEqual([...ADAPTER_SOURCE_KINDS]);
  });

  it("is entirely contained in the connector registry's vocabulary", () => {
    for (const kind of SOURCE_KINDS) {
      expect(CONNECTOR_KINDS).toContain(kind);
    }
  });

  /**
   * `flights` is the deprecated spelling of `aircraft`, still used by existing rows and code.
   * Remove this test once those are migrated.
   */
  it("keeps `flights` as the one deprecated extra connector kind", () => {
    const extras = CONNECTOR_KINDS.filter(
      (kind) => !(SOURCE_KINDS as readonly string[]).includes(kind),
    );
    expect(extras).toEqual(["flights"]);
  });
});

describe("workspace feature snapshots", () => {
  it("is reachable only through the `mapFeature` item kind", () => {
    expect(WORKSPACE_ITEM_KINDS).toContain("mapFeature");
  });

  /** Snapshots are immutable records of what an upstream said at one moment. */
  it("has no updatedAt column", () => {
    expect(Object.keys(workspaceFeatureSnapshots)).not.toContain("updatedAt");
  });
});

describe("poll modes", () => {
  it("defaults conservatively — a source is promoted to worker polling deliberately", () => {
    expect(POLL_MODES[0]).toBe("onDemand");
  });
});

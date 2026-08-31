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
 * Structural guards on the schema's own vocabularies.
 *
 * These are cheap and they catch the failure mode ADR 0004 designs around: a closed
 * vocabulary is defined in two places by necessity — a TypeScript array and a database CHECK
 * constraint rendered from it — and the two drift silently. A drift is only loud once
 * something tries to write the new value, which in the worst case is a production seed.
 *
 * There is no database connection here on purpose. The assertions that need one — that the
 * CHECK constraints actually exist and actually reject — belong to `scripts/verify-db.ts`
 * and the QA suite (HANDOFF §11).
 */

describe("source kind vocabulary", () => {
  /**
   * `db/schema.ts` deliberately does not import `SOURCE_KINDS` from `lib/sources/types.ts`,
   * for the reason the comment above it gives: the CHECK constraint is a database object and
   * cannot be changed by editing a TypeScript file elsewhere, so the schema's copy has to be
   * the thing a migration is written against. This test is the other half of that bargain —
   * it makes the duplication safe by making the drift impossible to commit.
   */
  it("mirrors lib/sources/types.ts value for value, in order", () => {
    expect([...SOURCE_KINDS]).toEqual([...ADAPTER_SOURCE_KINDS]);
  });

  it("is entirely contained in the connector registry's vocabulary", () => {
    for (const kind of SOURCE_KINDS) {
      expect(CONNECTOR_KINDS).toContain(kind);
    }
  });

  /**
   * `flights` is v1's spelling of `aircraft` and is retained only because live rows and code
   * outside this file still use it (ADR 0024). If this ever fails because someone removed it,
   * check that `db/seed.ts`, `lib/connectors/flights.ts` and `app/(public)/live/page.tsx`
   * were migrated in the same change — and then delete this test with them.
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

  /**
   * ADR 0025: a snapshot is a record of what an upstream said at one moment. An `updatedAt`
   * column would invite editing it, and an edited observation is a different claim wearing
   * the original's timestamp.
   */
  it("has no updatedAt column", () => {
    expect(Object.keys(workspaceFeatureSnapshots)).not.toContain("updatedAt");
  });
});

describe("poll modes", () => {
  it("defaults conservatively — a source is promoted to worker polling deliberately", () => {
    expect(POLL_MODES[0]).toBe("onDemand");
  });
});

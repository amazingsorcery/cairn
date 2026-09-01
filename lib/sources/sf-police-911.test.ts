import { afterEach, describe, expect, it, vi } from "vitest";

import { resetSourceRuntime } from "./http";
import { normaliseSfPolice911, sfPolice911, sfPolice911ResponseSchema } from "./sf-police-911";

/**
 * A REAL payload from data.sfgov.org (gnap-fj3t), captured 2026-09-01 and committed unedited.
 * On that capture 52 of 150 rows were `sensitive_call` with the location withheld by SFPD —
 * so this fixture is also the regression test for "drop what the operator hid".
 */
import fixture from "./__fixtures__/sf-police-911.json";
import { jsonResponse, testContext } from "./__fixtures__/context";

afterEach(() => {
  vi.restoreAllMocks();
  resetSourceRuntime();
});

/** The raw rows, for asserting against what the operator actually published. */
const rows = fixture as ReadonlyArray<Record<string, unknown>>;

describe("sf-police-911 normalise", () => {
  it("maps the captured live payload to renderable public-safety features", () => {
    const features = normaliseSfPolice911(fixture, {});
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.kind).toBe("publicSafety");
      expect(feature.id.startsWith("sf-police-911:")).toBe(true);
      expect(feature.properties.agency).toBe("San Francisco Police Department");
      expect(feature.properties.isMedical).toBe(feature.properties.category === "medical");
    }
  });

  it("DROPS every sensitive_call row — we never plot what the operator withheld", () => {
    const sensitiveCount = rows.filter((r) => r.sensitive_call === true).length;
    // The fixture must actually contain sensitive rows, or this proves nothing.
    expect(sensitiveCount).toBeGreaterThan(0);

    const features = normaliseSfPolice911(fixture, {});
    // No feature may correspond to a sensitive row. Sensitive rows also carry no location, so
    // the count of features can never exceed the non-sensitive rows.
    const nonSensitive = rows.filter((r) => r.sensitive_call !== true).length;
    expect(features.length).toBeLessThanOrEqual(nonSensitive);
  });

  it("drops rows the operator published without a location", () => {
    const withPoint = rows.filter(
      (r) => r.sensitive_call !== true && (r.intersection_point as unknown) != null,
    ).length;
    // Every rendered feature came from a non-sensitive row that had a point.
    expect(normaliseSfPolice911(fixture, {}).length).toBe(withPoint);
  });

  it("carries the dispatch-location precision caveat", () => {
    const [feature] = normaliseSfPolice911(fixture, {});
    expect(feature?.precision?.label).toContain("approx");
  });

  it("reconstructs nothing: a sensitive row with an injected coordinate is still dropped", () => {
    // Even if a coordinate is present, sensitive_call short-circuits to a drop. This guards
    // the "no identity resolution / honour the redaction" rule against a future upstream that
    // starts leaking a point on a sensitive row.
    const injected = [
      {
        id: "x1",
        sensitive_call: true,
        call_type_final_desc: "SUSPICIOUS PERSON",
        intersection_point: { type: "Point", coordinates: [-122.42, 37.77] },
      },
    ];
    expect(normaliseSfPolice911(injected, {})).toHaveLength(0);
  });
});

describe("sf-police-911 schema", () => {
  it("accepts the captured payload", () => {
    expect(sfPolice911ResponseSchema.safeParse(fixture).success).toBe(true);
  });

  it("requires sensitive_call — a missing flag must not default a call to shown", () => {
    expect(
      sfPolice911ResponseSchema.safeParse([{ id: "x", call_type_final_desc: "FRAUD" }]).success,
    ).toBe(false);
  });

  it("rejects an unrelated document", () => {
    expect(sfPolice911ResponseSchema.safeParse({ error: "unavailable" }).success).toBe(false);
  });
});

describe("sf-police-911 fetch", () => {
  it("returns features from a stubbed live response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(fixture));
    const result = await sfPolice911.fetch({}, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.features.length).toBeGreaterThan(0);
  });

  it("returns schemaChanged — not a throw — when the shape moves", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unavailable" }));
    const result = await sfPolice911.fetch({}, testContext());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });
});

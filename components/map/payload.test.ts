import { describe, expect, it } from "vitest";

import { layerPayloadSchema, parseLayerPayload } from "./payload";

/**
 * THE BOUNDARY TO OUR OWN ROUTE HANDLER.
 *
 * Both tests below are regressions for the same shape of bug: `z.object` strips what it does
 * not know and `z.discriminatedUnion` rejects a member it has never heard of, so a field
 * added to `lib/sources/types.ts` is not a compile error here — it is a value that silently
 * disappears, or a real operational state that arrives disguised as a parser bug.
 *
 * Both were real. `quotaExhausted` and `PositionalPrecision` were added to the contract and
 * this schema did not know about either.
 */

const SOURCE = {
  slug: "nws-alerts",
  name: "NWS active weather alerts",
  homepage: "https://www.weather.gov/",
  attribution: {
    text: "Weather alerts: NOAA / US National Weather Service",
    href: "https://www.weather.gov/",
    licence: "public domain (US Government)",
  },
  ttlSeconds: 60,
};

describe("failures survive the boundary as themselves", () => {
  it("parses quotaExhausted rather than turning it into a parser bug", () => {
    /*
     * Before this case existed the union rejected the payload, `parseLayerPayload` fell back
     * to `schemaChanged`, and the reader was told "our parser is broken and the fix needs a
     * deploy" when in fact we had simply spent our own polling budget. Wrong sentence, wrong
     * culprit, and it hides an operational condition behind a bug report.
     */
    const parsed = parseLayerPayload(
      {
        layerId: "weather-alerts",
        source: SOURCE,
        ok: false,
        failure: { kind: "quotaExhausted", resetsAt: "2026-08-31T12:00:00.000Z" },
        lastGoodAt: null,
      },
      "weather-alerts",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.kind).toBe("quotaExhausted");
  });

  it("coerces resetsAt back to a Date, because JSON has no date type", () => {
    const parsed = parseLayerPayload(
      {
        layerId: "weather-alerts",
        source: SOURCE,
        ok: false,
        failure: { kind: "quotaExhausted", resetsAt: "2026-08-31T12:00:00.000Z" },
        lastGoodAt: null,
      },
      "weather-alerts",
    );
    if (parsed.ok || parsed.failure.kind !== "quotaExhausted") throw new Error("wrong branch");
    // The contract types this as `Date`. A string wearing a `Date` annotation is the trap
    // `components/live/live-format.ts` documents for cached columns.
    expect(parsed.failure.resetsAt).toBeInstanceOf(Date);
  });

  it("still reports a genuinely unknown failure kind as schemaChanged", () => {
    const parsed = parseLayerPayload(
      { layerId: "x", source: SOURCE, ok: false, failure: { kind: "notAKind" }, lastGoodAt: null },
      "x",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.failure.kind).toBe("schemaChanged");
  });
});

describe("the positional caveat survives the boundary", () => {
  const feature = {
    id: "urn:oid:2.49.0.1.840.0.example",
    kind: "weather",
    longitude: -110.9,
    latitude: 32.2,
    label: "Severe Thunderstorm Warning",
    precision: {
      label: "zone centre",
      note: "This alert carries no map geometry, so it is drawn at the centre of zone AZC019.",
      approximateRadiusMetres: 40_000,
    },
    properties: { locationBasis: "zone", zoneCode: "AZC019" },
  };

  const payload = {
    layerId: "weather-alerts",
    source: SOURCE,
    ok: true as const,
    features: [feature],
    observedAt: "2026-08-31T11:47:22.000Z",
    stale: false,
  };

  it("is not stripped by the schema", () => {
    /*
     * THE REGRESSION THIS FILE EXISTS FOR. `z.object` drops unknown keys, so without a
     * `precision` entry the caveat rendered on page load (server-rendered, unparsed) and
     * VANISHED on the first client refresh thirty seconds later — with nothing in any log.
     * On a public-safety layer that is the worst available way for this field to fail.
     */
    const parsed = layerPayloadSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (!parsed.data.ok) throw new Error("wrong branch");
    expect(parsed.data.features[0]?.precision?.label).toBe("zone centre");
    expect(parsed.data.features[0]?.precision?.approximateRadiusMetres).toBe(40_000);
  });

  it("accepts a feature that has no caveat, because most do not need one", () => {
    const { precision: _precision, ...plain } = feature;
    const parsed = layerPayloadSchema.safeParse({ ...payload, features: [plain] });
    expect(parsed.success).toBe(true);
  });
});

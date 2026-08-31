import { describe, expect, it } from "vitest";

import { csvToRecords, FIRMS_API_KEY_ENV_VAR, nasaFirms, normaliseFirms, parseCsv } from "./nasa-firms";

/**
 * ⚠ NO CAPTURED FIXTURE EXISTS FOR THIS SOURCE, and that is deliberate rather than lazy.
 *
 * Every other adapter here is tested against a real payload held from the live upstream.
 * FIRMS requires a MAP_KEY obtained by registering an account, which the agent that wrote
 * this could not do; a keyless request returns `HTTP 400 / Invalid MAP_KEY.` and nothing else
 * (confirmed 2026-08-31).
 *
 * So the tests below are honest about what they cover: they exercise the CSV READER and the
 * MAPPING, using inputs written here. They do NOT prove the upstream's column names, and
 * writing a fake payload and calling it a fixture would assert exactly the thing that is
 * unverified. The first operator with a key must capture a real response to
 * `__fixtures__/nasa-firms.csv` and add the round-trip test — see `docs/sources/nasa-firms.md`.
 */

describe("firms CSV reader", () => {
  it("reads a header row and keys every value by column name", () => {
    const records = csvToRecords("latitude,longitude,frp\n1.5,2.5,10\n3.5,4.5,20\n");
    expect(records).toEqual([
      { latitude: "1.5", longitude: "2.5", frp: "10" },
      { latitude: "3.5", longitude: "4.5", frp: "20" },
    ]);
  });

  it("survives a column being reordered, because it reads by name and not by position", () => {
    const a = csvToRecords("latitude,longitude,frp\n1,2,3\n");
    const b = csvToRecords("frp,longitude,latitude\n3,2,1\n");
    expect(a).toEqual(b);
  });

  it("handles quoted fields and CRLF line endings", () => {
    const rows = parseCsv('a,b\r\n"x,y",z\r\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,y", "z"],
    ]);
  });

  it("ignores blank trailing lines rather than emitting an empty detection", () => {
    expect(csvToRecords("latitude,longitude\n1,2\n\n\n")).toHaveLength(1);
  });

  it("returns nothing for an empty body instead of throwing", () => {
    expect(csvToRecords("")).toEqual([]);
  });
});

describe("firms normalise", () => {
  const row = {
    latitude: "-8.31",
    longitude: "114.62",
    bright_ti4: "331.5",
    scan: "0.42",
    track: "0.38",
    acq_date: "2026-08-30",
    acq_time: "0512",
    satellite: "N",
    instrument: "VIIRS",
    confidence: "n",
    version: "2.0NRT",
    bright_ti5: "296.1",
    frp: "4.7",
    daynight: "N",
  };

  it("maps a detection to a renderable feature", () => {
    const result = normaliseFirms([row]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const feature = result.features[0];
    expect(feature?.kind).toBe("wildfires");
    expect(feature?.latitude).toBeCloseTo(-8.31, 5);
    expect(feature?.longitude).toBeCloseTo(114.62, 5);
    expect(feature?.properties.frpMw).toBe(4.7);
    expect(feature?.properties.brightnessK).toBe(331.5);
    expect(feature?.properties.night).toBe(true);
    expect(feature?.properties.detectedAt).toBe("2026-08-30T05:12:00.000Z");
  });

  it("keeps the upstream's confidence verbatim rather than flattening two scales into one", () => {
    // VIIRS says l/n/h; MODIS says 0-100. They do not mean the same thing, and normalising
    // them to a single number would invent a precision the data does not have.
    const viirs = normaliseFirms([{ ...row, confidence: "h" }]);
    const modis = normaliseFirms([{ ...row, confidence: "87" }]);
    if (!viirs.ok || !modis.ok) throw new Error("rows should parse");
    expect(viirs.features[0]?.properties.confidence).toBe("h");
    expect(modis.features[0]?.properties.confidence).toBe("87");
  });

  it("gives a detection an id stable across polls", () => {
    const first = normaliseFirms([row]);
    const second = normaliseFirms([row]);
    if (!first.ok || !second.ok) throw new Error("rows should parse");
    expect(first.features[0]?.id).toBe(second.features[0]?.id);
  });

  it("tolerates a product variant that omits optional columns", () => {
    // MODIS carries `brightness`/`bright_t31` where VIIRS carries `bright_ti4`/`bright_ti5`.
    const result = normaliseFirms([
      {
        latitude: "10",
        longitude: "20",
        acq_date: "2026-08-30",
        acq_time: "0512",
        brightness: "310.2",
      },
    ]);
    if (!result.ok) throw new Error("row should parse");
    expect(result.features[0]?.properties.brightnessK).toBe(310.2);
    expect(result.features[0]?.properties.frpMw).toBeNull();
  });

  it("returns schemaChanged when the required columns are missing", () => {
    // The guard that matters: an error page or a differently-shaped CSV must disable the
    // layer, not render "no fires anywhere on earth".
    const result = normaliseFirms(csvToRecords("message\nInvalid MAP_KEY.\n"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("schemaChanged");
  });

  it("drops a row whose coordinates are unusable", () => {
    const result = normaliseFirms([
      { ...row, latitude: "not-a-number" },
      { ...row, latitude: "999" },
      row,
    ]);
    if (!result.ok) throw new Error("rows should parse");
    expect(result.features).toHaveLength(1);
  });

  it("returns null rather than a bogus timestamp for a malformed acquisition time", () => {
    const result = normaliseFirms([{ ...row, acq_time: "not-a-time" }]);
    if (!result.ok) throw new Error("row should parse");
    expect(result.features[0]?.properties.detectedAt).toBeNull();
  });
});

describe("firms adapter contract", () => {
  it("names the env var holding its key, and fails as notConfigured without it", async () => {
    expect(nasaFirms.apiKeyEnvVar).toBe(FIRMS_API_KEY_ENV_VAR);

    const previous = process.env[FIRMS_API_KEY_ENV_VAR];
    delete process.env[FIRMS_API_KEY_ENV_VAR];
    try {
      const result = await nasaFirms.fetch(new AbortController().signal);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe("notConfigured");
      if (result.failure.kind !== "notConfigured") return;
      // The operator must be told WHICH variable is missing, or the message is useless.
      expect(result.failure.missingEnvVar).toBe(FIRMS_API_KEY_ENV_VAR);
    } finally {
      if (previous !== undefined) process.env[FIRMS_API_KEY_ENV_VAR] = previous;
    }
  });

  it("carries NASA's requested acknowledgement", () => {
    expect(nasaFirms.attribution.text).toContain("FIRMS");
    expect(nasaFirms.attribution.href).toContain("firms");
  });

  it("polls far inside the published 5000-transactions-per-10-minutes limit", () => {
    expect(nasaFirms.ttlSeconds).toBeGreaterThanOrEqual(900);
  });
});

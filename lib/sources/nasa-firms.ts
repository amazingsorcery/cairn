import { z } from "zod";

import {
  applyLimit,
  coordinatePair,
  healthcheckByFetch,
  normaliseVia,
  parseWith,
  withinBbox,
} from "./adapter";
import { fetchUpstream, lastGoodAt, recordGood, requireApiKey } from "./http";
import type {
  SourceAdapter,
  SourceContext,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "./types";

/**
 * NASA FIRMS — near-real-time active fire detections from MODIS and VIIRS.
 *
 * Terms (checked 2026-08-31):
 * Licence      Open (NASA open data policy); acknowledgement requested. NASA's wording:
 *              "We acknowledge the use of imagery from the NASA LANCE FIRMS
 *              (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and
 *              Information System (ESDIS)."
 * Key          Required: a free MAP_KEY (register at firms.modaps.eosdis.nasa.gov), in
 *              `FIRMS_MAP_KEY`.
 * Rate limit   5000 transactions / 10 minutes per key. A 15-minute TTL (about the satellite
 *              revisit cadence) is far inside it.
 *
 * Not verified against a live payload: without a key the API only returns
 * `HTTP 400 Invalid MAP_KEY.` Column names come from NASA's docs. The parser reads columns by
 * name and requires only `latitude`, `longitude`, `acq_date`, `acq_time`. Before enabling,
 * capture a real response to `lib/sources/__fixtures__/nasa-firms.csv` and add a round-trip
 * test.
 */

const API_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

/** Allowlist of products, since the value goes into a server-side fetch URL. */
const SOURCES = [
  "LANDSAT_NRT",
  "MODIS_NRT",
  "MODIS_SP",
  "VIIRS_NOAA20_NRT",
  "VIIRS_NOAA20_SP",
  "VIIRS_NOAA21_NRT",
  "VIIRS_SNPP_NRT",
  "VIIRS_SNPP_SP",
] as const;
type FirmsSource = (typeof SOURCES)[number];

/** VIIRS Suomi-NPP NRT: 375 m resolution (MODIS is 1 km). */
const DEFAULT_SOURCE: FirmsSource = "VIIRS_SNPP_NRT";

function selectedSource(env: (name: string) => string | undefined): FirmsSource {
  const requested = env("FIRMS_SOURCE")?.trim();
  return SOURCES.find((source) => source === requested) ?? DEFAULT_SOURCE;
}

export const FIRMS_API_KEY_ENV_VAR = "FIRMS_MAP_KEY";

/** `world` is the documented shorthand for the maximum bounding box. */
const AREA = "world";

/** Days of detections. The documented range is 1–5; one day is what a live map wants. */
const DAY_RANGE = 1;

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/** Minimal CSV reader. Handles quoted fields in case one ever appears (it'd shift columns). */
export function parseCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some((value) => value !== "")) rows.push(row);

  return rows;
}

/** Rows as name-keyed records, so a column order change doesn't shift values. */
export function csvToRecords(text: string): readonly Readonly<Record<string, string>>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const columns = header.map((name) => name.trim().toLowerCase());

  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < columns.length; c += 1) {
      const key = columns[c];
      if (key) record[key] = row[c] ?? "";
    }
    records.push(record);
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * Numeric column: a bad value becomes `null` (row dropped), but a missing column fails the
 * parse (every record has every header key), so the layer degrades instead of showing no fires.
 */
const numeric = z.string().transform((value) => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
});

/**
 * Only the four columns common to all FIRMS products are required; the rest are optional.
 * The required ones also catch error pages, which fail as `schemaChanged`.
 */
const detectionSchema = z
  .object({
    latitude: numeric,
    longitude: numeric,
    acq_date: z.string(),
    acq_time: z.string(),
    brightness: numeric.optional(),
    bright_ti4: numeric.optional(),
    bright_ti5: numeric.optional(),
    bright_t31: numeric.optional(),
    frp: numeric.optional(),
    scan: numeric.optional(),
    track: numeric.optional(),
    /** VIIRS: `l`/`n`/`h`. MODIS: a 0–100 integer as a string. Kept as text either way. */
    confidence: z.string().optional(),
    satellite: z.string().optional(),
    instrument: z.string().optional(),
    version: z.string().optional(),
    /** `D` or `N`. A night detection is far less likely to be a sun-glint false positive. */
    daynight: z.string().optional(),
  })
  .passthrough();

export const firmsResponseSchema = z.array(detectionSchema).min(0);

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface WildfireFeature extends SourceFeature {
  readonly kind: "wildfires";
  readonly properties: {
    /** ISO 8601, from the acquisition date and UTC time the satellite recorded. */
    readonly detectedAt: string | null;
    /** Fire radiative power, MW. Roughly "how big". */
    readonly frpMw: number | null;
    /** Brightness temperature, kelvin. VIIRS I-4 / MODIS band 21, whichever the product has. */
    readonly brightnessK: number | null;
    /** Upstream confidence as-is: `l`/`n`/`h` (VIIRS) or 0–100 (MODIS); not comparable. */
    readonly confidence: string | null;
    readonly satellite: string | null;
    readonly instrument: string | null;
    /** True when detected at night, which materially reduces false positives. */
    readonly night: boolean;
  };
}

/** `acq_date` = `YYYY-MM-DD`, `acq_time` = `HHMM` UTC (sometimes zero-padded to 4). */
function detectedAtIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const padded = time.padStart(4, "0");
  if (!/^\d{4}$/.test(padded)) return null;
  const iso = `${date}T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

type FirmsPayload = z.infer<typeof firmsResponseSchema>;

/** Map validated rows to features. `fetch` has already decided the columns are present. */
function mapFirms(data: FirmsPayload, query: SourceQuery): readonly WildfireFeature[] {
  const features: WildfireFeature[] = [];
  let index = 0;

  for (const row of data) {
    index += 1;
    const position = coordinatePair(row.longitude, row.latitude);
    if (!position) continue;

    const detectedAt = detectedAtIso(row.acq_date, row.acq_time);
    const brightness = row.bright_ti4 ?? row.brightness ?? null;

    const feature: WildfireFeature = {
      // No upstream id: position + acquisition time is stable across polls; index breaks ties.
      id: `${position.latitude.toFixed(5)},${position.longitude.toFixed(5)}@${row.acq_date}T${row.acq_time}#${index}`,
      kind: "wildfires",
      longitude: position.longitude,
      latitude: position.latitude,
      label: `Fire detection${row.frp !== null && row.frp !== undefined ? ` — ${row.frp} MW` : ""}`,
      sourceUrl: "https://firms.modaps.eosdis.nasa.gov/map/",
      properties: {
        detectedAt,
        frpMw: row.frp ?? null,
        brightnessK: brightness,
        confidence: row.confidence ?? null,
        satellite: row.satellite ?? null,
        instrument: row.instrument ?? null,
        night: (row.daynight ?? "").toUpperCase() === "N",
      },
    };

    // Poll `world` once and filter here; per-viewport requests would burn the budget.
    if (!withinBbox(feature, query)) continue;
    features.push(feature);
  }

  return applyLimit(features, query);
}

/** Public mapper, for tests. Validates, then maps. */
export const normaliseFirms = normaliseVia(firmsResponseSchema, mapFirms);

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const NASA_FIRMS_SLUG = "nasa-firms";

export const nasaFirms: SourceAdapter<WildfireFeature> = {
  slug: NASA_FIRMS_SLUG,
  name: "NASA FIRMS active fires",
  kind: "wildfires",
  homepage: "https://firms.modaps.eosdis.nasa.gov/",
  attribution: {
    // NASA's acknowledgement, shortened for the legend (full text in the header comment).
    text: "Active fire data: NASA LANCE FIRMS (ESDIS)",
    href: "https://earthdata.nasa.gov/firms",
    licence: "open (NASA open data policy; acknowledgement requested)",
  },
  /** Matches satellite revisit cadence. */
  ttlSeconds: 900,
  /** Data only changes per satellite pass, so staleness costs little. */
  staleWhileRevalidateSeconds: 3600,
  apiKeyEnvVar: FIRMS_API_KEY_ENV_VAR,
  responseSchema: firmsResponseSchema,
  normalise: normaliseFirms,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<WildfireFeature>> {
    const key = requireApiKey(ctx.env, FIRMS_API_KEY_ENV_VAR);
    if (!key.ok) {
      // No key disables only this layer.
      return { ok: false, failure: key.failure, lastGoodAt: lastGoodAt(NASA_FIRMS_SLUG) };
    }

    const url =
      `${API_BASE}/${encodeURIComponent(key.key)}/${selectedSource(ctx.env)}` +
      `/${AREA}/${DAY_RANGE}`;

    const outcome = await fetchUpstream({
      slug: NASA_FIRMS_SLUG,
      url,
      signal: ctx.signal,
      // A global day of detections is a large CSV.
      timeoutMs: 30_000,
      maxBytes: 32 * 1024 * 1024,
      headers: { accept: "text/csv" },
    });
    if (!outcome.ok) {
      return { ok: false, failure: outcome.failure, lastGoodAt: lastGoodAt(NASA_FIRMS_SLUG) };
    }

    // A bad key is a 400 (handled above). The schema catches a 200 carrying a message
    // instead of CSV, which would otherwise parse as zero fires.
    const records = csvToRecords(outcome.text);
    const parsed = parseWith(firmsResponseSchema, records);
    if (!parsed.ok) {
      return { ok: false, failure: parsed.failure, lastGoodAt: lastGoodAt(NASA_FIRMS_SLUG) };
    }

    const features = mapFirms(parsed.data, query);
    // No envelope timestamp; per-detection time is `properties.detectedAt`.
    const observedAt = new Date();
    recordGood(NASA_FIRMS_SLUG, observedAt);
    return { ok: true, features, observedAt };
  },

  healthcheck(ctx: SourceContext) {
    return healthcheckByFetch(nasaFirms, ctx);
  },
};

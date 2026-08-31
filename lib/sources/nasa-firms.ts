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
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-08-31. Full record in `docs/sources/nasa-firms.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence      Open. NASA's FIRMS FAQ (earthdata.nasa.gov/data/tools/firms/faq, read
 *              2026-08-31) states that "NASA promotes full and open sharing of data" and asks
 *              for an acknowledgement rather than imposing a restrictive licence.
 * Attribution  NASA's own requested wording, quoted from that page:
 *              "We acknowledge the use of imagery from the NASA LANCE FIRMS
 *              (https://earthdata.nasa.gov/firms), part of the NASA Earth Science Data and
 *              Information System (ESDIS)."
 * Key          REQUIRED. A free MAP_KEY, obtained by registering an email address at
 *              firms.modaps.eosdis.nasa.gov. Held in `FIRMS_MAP_KEY`.
 * Rate limit   PUBLISHED, and unusually clearly: "MAP_KEY limit is 5000 transactions /
 *              10-minute interval. Larger transactions may count as multiple requests (ex.
 *              requesting 7 days)." (firms.modaps.eosdis.nasa.gov/api/area/, read
 *              2026-08-31.) A 15-minute TTL is four requests an hour against a budget of
 *              30,000 — three orders of magnitude inside the limit, and it matches
 *              product-brief §2b ("fires ~15min"), which is roughly the satellite revisit
 *              cadence anyway. Polling faster would return the same rows.
 * Access ctrl  None circumvented: a documented endpoint, with our own key.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ WHAT IS **NOT** VERIFIED, AND WHY — READ BEFORE ENABLING THIS LAYER
 *
 * The response shape has NOT been checked against a live payload. Obtaining a MAP_KEY
 * requires registering an account, which the agent that wrote this adapter is not permitted
 * to do, and a keyless request returns exactly one thing (confirmed 2026-08-31):
 *
 *     HTTP 400, body: `Invalid MAP_KEY.`
 *
 * So unlike every other adapter here, there is no captured fixture, and the column names
 * below come from NASA's product documentation rather than from a response we have held. The
 * parser is written defensively to make that gap as small as possible — it reads columns BY
 * NAME from the header row, requires only the four that every FIRMS product carries
 * (`latitude`, `longitude`, `acq_date`, `acq_time`), and treats everything else as optional —
 * but "defensive" is not "verified".
 *
 * **The operator with the first MAP_KEY must capture a real response to
 * `lib/sources/__fixtures__/nasa-firms.csv` and add the round-trip test before this layer is
 * enabled.** `docs/sources/nasa-firms.md` carries the same instruction. Shipping this
 * unflagged is precisely the fabricated-confidence failure product-brief §6 warns about.
 */

const API_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

/**
 * The documented satellite products. An allowlist, not a free-text env var: the value is
 * interpolated into a URL we fetch server-side (ADR 0019's top risk), and only these strings
 * can ever reach it.
 */
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

/**
 * VIIRS Suomi-NPP near-real-time: 375 m resolution, global, and the product FIRMS itself
 * leads with. MODIS is 1 km and coarser; the NOAA-20/21 products are equivalent alternatives
 * an operator may prefer for revisit timing.
 */
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

/**
 * A minimal CSV reader, sufficient for this payload and no more.
 *
 * FIRMS emits plain comma-separated values with no embedded commas, quotes or newlines in any
 * documented column, so a full RFC 4180 parser would be dead weight — but quoted fields are
 * handled anyway, because the cost is six lines and the failure mode of not handling them is
 * a silently shifted column, which is the worst kind of wrong on a map.
 */
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

/**
 * Rows as name-keyed records, so a column ORDER change cannot silently shift every value.
 * Reading by position is how a fire ends up rendered at its own brightness temperature.
 */
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
 * A numeric column, tolerant of one bad VALUE but not of a missing COLUMN.
 *
 * The distinction is the whole design here. A single malformed row must not disable the
 * wildfire layer — so a value that will not parse becomes `null` and `normalise` drops that
 * row. But the KEY must be present, and `csvToRecords` sets every header column on every
 * record, so a payload whose header lacks `latitude` fails the parse and the layer degrades
 * honestly instead of reporting no fires on earth.
 */
const numeric = z.string().transform((value) => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
});

/**
 * Only the four columns every documented FIRMS product carries are required. Everything else
 * is optional, so a product variant that omits `bright_ti5` degrades one field to null rather
 * than disabling the whole layer.
 *
 * The required four are also the *guard*: if the response is an error page, a login form or a
 * differently-shaped CSV, the header will not carry `latitude` and `longitude` and the parse
 * fails with `schemaChanged` — rather than rendering "no fires anywhere on earth", which for
 * this layer would be a confident, dangerous lie.
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
    /**
     * Fire radiative power, megawatts. The closest thing here to "how big is it", and the
     * field most worth sorting a table by.
     */
    readonly frpMw: number | null;
    /** Brightness temperature, kelvin. VIIRS I-4 / MODIS band 21, whichever the product has. */
    readonly brightnessK: number | null;
    /**
     * The upstream's own confidence, unaltered: `l`/`n`/`h` for VIIRS, 0–100 for MODIS. NOT
     * normalised to a single scale — the two mean different things, and flattening them would
     * invent a precision the data does not have.
     */
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
      /**
       * FIRMS gives detections no id. The identity is the pixel and the moment: a rounded
       * position plus the acquisition timestamp is stable across polls for the same
       * detection, which is what `SourceFeature.id` promises. The index is a tiebreaker for
       * the rare case of two rows sharing both.
       */
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

    // We request `world` and filter here. The area API does accept a bounding box, but a
    // per-viewport request would multiply transactions against the 5000/10min budget while a
    // single global poll serves every reader from one entry.
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
    // NASA's own requested acknowledgement, shortened to fit a map legend. The full sentence
    // is in `docs/sources/nasa-firms.md` and belongs on the layer's about panel.
    text: "Active fire data: NASA LANCE FIRMS (ESDIS)",
    href: "https://earthdata.nasa.gov/firms",
    licence: "open (NASA open data policy; acknowledgement requested)",
  },
  /** Well inside 5000 transactions / 10 minutes, and matched to satellite revisit cadence. */
  ttlSeconds: 900,
  /**
   * One hour against a 15-minute TTL. FIRMS is satellite-pass driven, so the underlying data
   * genuinely does not change between passes and staleness costs little.
   */
  staleWhileRevalidateSeconds: 3600,
  apiKeyEnvVar: FIRMS_API_KEY_ENV_VAR,
  responseSchema: firmsResponseSchema,
  normalise: normaliseFirms,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<WildfireFeature>> {
    const key = requireApiKey(ctx.env, FIRMS_API_KEY_ENV_VAR);
    if (!key.ok) {
      // A deployment with no key disables this layer alone and the rest of the map comes up.
      return { ok: false, failure: key.failure, lastGoodAt: lastGoodAt(NASA_FIRMS_SLUG) };
    }

    const url =
      `${API_BASE}/${encodeURIComponent(key.key)}/${selectedSource(ctx.env)}` +
      `/${AREA}/${DAY_RANGE}`;

    const outcome = await fetchUpstream({
      slug: NASA_FIRMS_SLUG,
      url,
      signal: ctx.signal,
      // A global day of VIIRS detections is a large CSV and the request is not cheap for
      // them either; give it room and time.
      timeoutMs: 30_000,
      maxBytes: 32 * 1024 * 1024,
      headers: { accept: "text/csv" },
    });
    if (!outcome.ok) {
      return { ok: false, failure: outcome.failure, lastGoodAt: lastGoodAt(NASA_FIRMS_SLUG) };
    }

    /**
     * A wrong or exhausted key comes back as HTTP 400 with the body `Invalid MAP_KEY.`
     * (confirmed 2026-08-31) — so it is already an `upstreamError` above. The schema below
     * catches the other shape: a 200 carrying a message rather than a CSV. Without it, a
     * one-line error body parses as "zero fires", which on this layer is a lie with
     * consequences.
     */
    const records = csvToRecords(outcome.text);
    const parsed = parseWith(firmsResponseSchema, records);
    if (!parsed.ok) {
      return { ok: false, failure: parsed.failure, lastGoodAt: lastGoodAt(NASA_FIRMS_SLUG) };
    }

    const features = mapFirms(parsed.data, query);
    /**
     * CSV rows carry no envelope timestamp, so `observedAt` is our receive time. The
     * per-detection acquisition time — the number that actually matters for a fire — is in
     * `properties.detectedAt`.
     */
    const observedAt = new Date();
    recordGood(NASA_FIRMS_SLUG, observedAt);
    return { ok: true, features, observedAt };
  },

  healthcheck(ctx: SourceContext) {
    return healthcheckByFetch(nasaFirms, ctx);
  },
};

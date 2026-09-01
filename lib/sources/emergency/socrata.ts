import { z } from "zod";

import { applyLimit, coordinatePair, healthcheckByFetch, withinBbox } from "../adapter";
import { decodeJson, fetchUpstream, lastGoodAt, recordGood } from "../http";
import type {
  Attribution,
  PositionalPrecision,
  SourceAdapter,
  SourceContext,
  SourceFeature,
  SourceQuery,
  SourceResult,
} from "../types";
import { classifyIncident, type IncidentCategory } from "./incident-type";

/**
 * The shared machinery behind every US municipal open-data CAD/911 adapter.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE FILE PER CITY, ONE HELPER FOR THE PART THAT IS THE SAME
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR 0033 is explicit: **per-city adapter — a city that does not publish it does not get
 * one.** So Seattle and San Francisco are two `SourceAdapter`s in two files, each with its
 * own slug, its own terms record in `docs/sources/<slug>.md`, and its own row in the
 * connector registry. This is NOT the camera seam (one adapter over N providers): a city's
 * dispatch is one upstream under one licence, which is exactly the shape `SourceAdapter` is
 * for. What the cities share is the Socrata transport and the feature they produce, and only
 * that lives here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BINDING CONSTRAINTS, ENFORCED HERE SO A CITY CANNOT FORGET THEM
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR 0033, and QA will check each:
 *   - **Live-only, nothing persisted.** These adapters return features; nothing here writes
 *     to a database. The `mapFeature` save path excludes this layer (map-engineer's concern);
 *     this module never offers a persistence handle to tempt it.
 *   - **Medical carries an explicit field.** Every feature has `properties.category` and
 *     `properties.isMedical`, classified from the operator's own call type by
 *     `incident-type.ts`. Medical is never dropped and never shown by default — the UI reads
 *     `isMedical` to keep it OFF until a reader opts in.
 *   - **No identity resolution.** We map the row the operator published to a point and stop.
 *     No field is cross-referenced against anything; a `sensitive`-flagged row whose location
 *     the operator has already withheld is dropped rather than reconstructed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SOCRATA (SODA) — THE TRANSPORT
 * ─────────────────────────────────────────────────────────────────────────────
 * Both cities publish through Socrata's SODA API. An app token is OPTIONAL: without one,
 * requests share a per-IP throttle; with one (sent as `X-App-Token`), Socrata does not
 * throttle reasonable use. We poll once per TTL from the worker, comfortably inside even the
 * anonymous throttle, so a missing token DEGRADES (slower, possibly a 429 under load) rather
 * than DISABLES — it is not an `apiKeyEnvVar`, and the layer still boots without it.
 */

/* ------------------------------------------------------------------ *
 * The feature every emergency city produces
 * ------------------------------------------------------------------ */

export interface EmergencyFeature extends SourceFeature {
  readonly kind: "publicSafety";
  readonly properties: {
    /** The operator's own call type, verbatim. Never re-worded; the classifier reads it. */
    readonly incidentType: string;
    /** Coarse category for the legend and the layer toggles. See `incident-type.ts`. */
    readonly category: IncidentCategory;
    /**
     * TRUE → the UI keeps this call OFF by default. A medical call is health data about an
     * identifiable person at an address (ADR 0033). The one flag a layer reads before it
     * renders a dispatch by default.
     */
    readonly isMedical: boolean;
    /** Which service dispatched, e.g. "Seattle Fire Department", "San Francisco Police". */
    readonly agency: string;
    /** City and state, for the legend and the table. */
    readonly city: string;
    /** The operator's incident/CAD number, so a reader can get back to the record. Or null. */
    readonly incidentNumber: string | null;
    /** Block or intersection AS PUBLISHED by the operator. Never geocoded or refined by us. */
    readonly address: string | null;
    /** Dispatch priority where the operator publishes one (SF: A/B/C/E). Seattle: null. */
    readonly priority: string | null;
    /** When the call was received/dispatched, ISO 8601. Not our fetch time. */
    readonly dispatchedAt: string | null;
    /** Final disposition where published (SF). Null where the operator does not (Seattle). */
    readonly disposition: string | null;
  };
}

/**
 * Dispatch coordinates are a REPORTED location, block- or intersection-level.
 *
 * Carried on the feature (not derived per-layer) so it travels into a workspace snapshot and
 * a PDF export, where the map's renderer never runs — the same hole `PositionalPrecision`
 * closed for NWS zone centroids (`types.ts`). An emergency dispatch point is where the call
 * was reported, often an intersection or block face, not a rooftop; saying so is the honest
 * caveat and stops a reader reading a precise-looking coordinate months later as an exact
 * address.
 */
const DISPATCH_PRECISION: PositionalPrecision = {
  label: "approx · dispatch location",
  note:
    "The coordinate is the reported dispatch location as the agency published it — typically " +
    "a block or intersection, not a specific address or rooftop.",
  approximateRadiusMetres: 150,
};

/* ------------------------------------------------------------------ *
 * The per-city specification
 * ------------------------------------------------------------------ */

/** One normalised row, city-neutral, before it becomes a feature. */
export interface EmergencyRecord {
  readonly id: string;
  readonly incidentType: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly incidentNumber: string | null;
  readonly address: string | null;
  readonly priority: string | null;
  readonly dispatchedAt: string | null;
  readonly disposition: string | null;
}

/**
 * Everything a city adapter needs, generic over its ROW schema.
 *
 * The row schema is the unit of validation; the adapter wraps it in `z.array(...)` itself, so
 * a city writes and tests one row shape rather than an array shape. `toRecord` is typed
 * against that row with no `any` at the seam, and may return `null` to DROP a row — which is
 * how a city honours the operator's own redaction (SFPD withholds a sensitive call's
 * location) or discards a row with no usable coordinate.
 */
export interface EmergencyCitySpec<R extends z.ZodTypeAny> {
  readonly slug: string;
  readonly name: string;
  readonly homepage: string;
  readonly agency: string;
  readonly city: string;
  readonly attribution: Attribution;
  /** The SODA resource endpoint, a module constant — nothing from a request reaches it. */
  readonly resourceUrl: string;
  readonly ttlSeconds: number;
  readonly staleWhileRevalidateSeconds: number;
  readonly rowSchema: R;
  readonly toRecord: (row: z.infer<R>) => EmergencyRecord | null;
}

/** What `defineEmergencyCity` returns: the adapter, plus the composed array schema for tests. */
export interface EmergencyCity {
  readonly adapter: SourceAdapter<EmergencyFeature>;
  readonly responseSchema: z.ZodTypeAny;
  /** Validate a captured payload and map it — the no-network fixture-test entry point. */
  readonly normalise: (payload: unknown, query: SourceQuery) => readonly EmergencyFeature[];
}

/* ------------------------------------------------------------------ *
 * The Socrata transport
 * ------------------------------------------------------------------ */

const APP_TOKEN_ENV_VAR = "SOCRATA_APP_TOKEN";

/** Optional `X-App-Token`. Present raises Socrata's throttle; absent, we poll inside it. */
function socrataHeaders(env: (name: string) => string | undefined): Record<string, string> {
  const token = env(APP_TOKEN_ENV_VAR)?.trim();
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["x-app-token"] = token;
  return headers;
}

/**
 * Build a `SourceAdapter` for one city from its spec.
 *
 * `fetch` is the same five steps every adapter runs — cooldown-guarded fetch, decode,
 * validate, map, record — with every failure a typed value rather than a throw
 * (product-brief §2b). It does not reuse `pollJson` only because SODA needs the optional
 * app-token header; the validation and mapping discipline is identical.
 */
export function defineEmergencyCity<R extends z.ZodTypeAny>(spec: EmergencyCitySpec<R>): EmergencyCity {
  const responseSchema = z.array(spec.rowSchema).min(0);

  function recordToFeature(record: EmergencyRecord): EmergencyFeature | null {
    const position = coordinatePair(record.longitude, record.latitude);
    // No usable coordinate → not drawable, and dropping it here keeps the on-screen count
    // honest rather than parking a dispatch at null island.
    if (!position) return null;

    const classification = classifyIncident(record.incidentType);
    return {
      id: `${spec.slug}:${record.id}`,
      kind: "publicSafety",
      longitude: position.longitude,
      latitude: position.latitude,
      label: record.incidentType || "Dispatch",
      sourceUrl: spec.homepage,
      precision: DISPATCH_PRECISION,
      properties: {
        incidentType: record.incidentType,
        category: classification.category,
        isMedical: classification.isMedical,
        agency: spec.agency,
        city: spec.city,
        incidentNumber: record.incidentNumber,
        address: record.address,
        priority: record.priority,
        dispatchedAt: record.dispatchedAt,
        disposition: record.disposition,
      },
    };
  }

  function mapRows(rows: readonly z.infer<R>[], query: SourceQuery): readonly EmergencyFeature[] {
    const features: EmergencyFeature[] = [];
    for (const row of rows) {
      const record = spec.toRecord(row);
      if (!record) continue;
      const feature = recordToFeature(record);
      if (!feature) continue;
      if (!withinBbox(feature, query)) continue;
      features.push(feature);
    }
    return applyLimit(features, query);
  }

  const normalise = (payload: unknown, query: SourceQuery): readonly EmergencyFeature[] => {
    const parsed = responseSchema.safeParse(payload);
    return parsed.success ? mapRows(parsed.data, query) : [];
  };

  const adapter: SourceAdapter<EmergencyFeature> = {
    slug: spec.slug,
    name: spec.name,
    kind: "publicSafety",
    homepage: spec.homepage,
    attribution: spec.attribution,
    ttlSeconds: spec.ttlSeconds,
    staleWhileRevalidateSeconds: spec.staleWhileRevalidateSeconds,
    responseSchema,
    normalise,

    async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<EmergencyFeature>> {
      const outcome = await fetchUpstream({
        slug: spec.slug,
        url: spec.resourceUrl,
        signal: ctx.signal,
        headers: socrataHeaders(ctx.env),
        // Small JSON — the SODA URL carries its own $order and $limit — so the default byte
        // cap is plenty. A touch more time than the default: SODA can be slow under load.
        timeoutMs: 12_000,
      });
      if (!outcome.ok) return { ok: false, failure: outcome.failure, lastGoodAt: lastGoodAt(spec.slug) };

      const decoded = decodeJson(outcome.text);
      if (!decoded.ok) return { ok: false, failure: decoded.failure, lastGoodAt: lastGoodAt(spec.slug) };

      const parsed = responseSchema.safeParse(decoded.body);
      if (!parsed.success) {
        const paths = parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`)
          .join("; ");
        return {
          ok: false,
          failure: {
            kind: "schemaChanged",
            message: `${spec.slug} payload did not match the expected schema (${paths})`,
          },
          lastGoodAt: lastGoodAt(spec.slug),
        };
      }

      const features = mapRows(parsed.data, query);
      // SODA rows carry no envelope timestamp; the per-call dispatch time is in
      // `properties.dispatchedAt`, and `observedAt` is our receive time for the payload.
      const observedAt = new Date();
      recordGood(spec.slug, observedAt);
      return { ok: true, features, observedAt };
    },

    healthcheck(ctx: SourceContext) {
      return healthcheckByFetch(adapter, ctx);
    },
  };

  return { adapter, responseSchema, normalise };
}

export { APP_TOKEN_ENV_VAR };

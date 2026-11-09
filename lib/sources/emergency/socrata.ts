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
 * One adapter per city (each its own slug and registry row); only the Socrata transport and
 * feature shape are shared here.
 *
 * Constraints enforced here:
 *   - Live-only: nothing is persisted.
 *   - Every feature has `category` and `isMedical`; medical calls are kept but hidden by
 *     default in the UI.
 *   - No identity resolution. Rows whose location the operator withheld are dropped, not
 *     reconstructed.
 *
 * Socrata app token (`X-App-Token`) is optional: without it requests share a per-IP throttle,
 * which our polling stays inside. So it's not an `apiKeyEnvVar`; missing it only degrades.
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
    /** True means the UI hides this call by default (health data about a person). */
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
 * Dispatch coordinates are a reported block/intersection, not an address. Carried on the
 * feature so the caveat survives into workspace snapshots and exports.
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
 * A city adapter spec, generic over its row schema (wrapped in `z.array` here). `toRecord`
 * returns `null` to drop a row, e.g. operator-redacted or with no usable coordinate.
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
 * Build a `SourceAdapter` for one city. Same steps as `pollJson` (fetch, decode, validate,
 * map, record; failures are typed values), but with the optional app-token header.
 */
export function defineEmergencyCity<R extends z.ZodTypeAny>(spec: EmergencyCitySpec<R>): EmergencyCity {
  const responseSchema = z.array(spec.rowSchema).min(0);

  function recordToFeature(record: EmergencyRecord): EmergencyFeature | null {
    const position = coordinatePair(record.longitude, record.latitude);
    // No usable coordinate: drop rather than draw at 0,0.
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
        // Small JSON ($limit in the URL); extra time because SODA can be slow under load.
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

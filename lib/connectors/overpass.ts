import { createHash } from "node:crypto";

import { z } from "zod";

import type { Connector } from "@/db/schema";
import {
  canonicaliseQuery,
  normaliseOverpass,
  OSM_ATTRIBUTION,
  QUERY_TIMEOUT_SECONDS,
  type OverpassResult,
} from "@/lib/toolbench/overpass";
import { UpstreamStatusError } from "./runtime";
import { upstreamRequest } from "./upstream";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/overpass-builder`: OpenStreetMap feature queries against the public Overpass API.
 *
 * Notes (verified 2026-09-01):
 * - `POST /api/interpreter` with the query in a `data=` form field.
 * - Results are OSM data (ODbL 1.0); attribution is rendered next to results.
 * - Usage policy (https://dev.overpass-api.de/overpass-doc/en/preface/commons.html): ~10k
 *   requests and <1 GB per day per user; 429 for rate limits, 504 for resource refusals;
 *   undeclared queries get 180s / 512 MiB.
 * - The policy names "an app ... relying on the public instances as backend" as problematic
 *   and recommends self-hosting. So the row seeds disabled, quotas are a small fraction of the
 *   guideline, results are cached across readers, and the tool page points heavy use at
 *   overpass-turbo. Long term: run our own instance.
 *
 * Not a legal opinion.
 *
 * The query text (a reader's area of interest) is never logged or persisted.
 */

export const OVERPASS_CONNECTOR_SLUG = "overpass-api-de";

/** The only host this driver will send a query to. See the check in `fetch`. */
const OVERPASS_HOST = "overpass-api.de";

/** Untrusted; `normalise` parses and re-emits it via the Toolbench grammar. */
const requestSchema = z.object({ query: z.string() });

export type OverpassParams = { readonly query: string };

export type OverpassPayload = {
  readonly result: OverpassResult;
  /** The canonical query that actually ran, so the page can show what was sent. */
  readonly query: string;
};

/** Validate and canonicalise. Throws on bad input; `runConnector` then makes no call. */
function normalise(raw: unknown): OverpassParams {
  const parsed = requestSchema.parse(raw);
  const canonical = canonicaliseQuery(parsed.query);
  if (!canonical.ok) throw new Error(canonical.error);
  return { query: canonical.value };
}

export const overpassDriver: ConnectorDriver<OverpassParams, OverpassPayload> = {
  /** `infrastructure` covers Toolbench tools that take a user-supplied query. */
  kind: "infrastructure",
  slug: OVERPASS_CONNECTOR_SLUG,
  normalise,

  /**
   * Shared across readers, nothing about the caller. Hashed (SHA-256, 128 bits) because keys
   * can appear in log scopes and the query is the reader's search area.
   */
  cacheKey: (params) => createHash("sha256").update(params.query).digest("hex").slice(0, 32),

  async fetch(connector: Connector, params, signal) {
    // Never send to an unrecognised host, whatever the registry row says (several
    // connectors share the `infrastructure` kind).
    const base = connector.baseUrl.replace(/\/+$/, "");
    if (new URL(base).hostname !== OVERPASS_HOST) {
      throw new UpstreamStatusError(502);
    }
    const url = `${base}/api/interpreter`;

    // POST rather than GET so the query stays out of the upstream's access log.
    const body = new URLSearchParams({ data: params.query }).toString();

    // `upstreamRequest` pins the host, caps the streamed body and counts the request. No
    // redirects are followed, so the query is never re-POSTed elsewhere.
    const response = await upstreamRequest({
      url,
      pinnedHost: OVERPASS_HOST,
      method: "POST",
      body: { contentType: "application/x-www-form-urlencoded", text: body },
      accept: "application/json",
      signal,
      // Normal answers (`out center 1000`) are a few hundred KB.
      maxBytes: 8 * 1024 * 1024,
    });

    // Overpass sometimes returns an HTML error page with a 200; non-JSON is an upstream error,
    // not zero features. 429/504 are thrown by `upstreamRequest` with the real status.
    let body_: unknown;
    try {
      body_ = JSON.parse(response.text) as unknown;
    } catch {
      throw new UpstreamStatusError(502);
    }

    const result = normaliseOverpass(body_);
    if (!result.ok) throw new UpstreamStatusError(502);

    return { data: { result: result.value, query: params.query }, upstreamStatus: response.status };
  },
};

/** Registry row, seeded by `db/seed.ts`. Disabled/draft; read the usage policy in `legalBasis` first. */
export const OVERPASS_CONNECTOR_SEED = {
  slug: OVERPASS_CONNECTOR_SLUG,
  name: "Overpass API",
  kind: "infrastructure" as const,
  operatorName: "Overpass API public instances (overpass-api.de, community-operated)",
  homepageUrl: "https://overpass-api.de/",
  termsUrl: "https://dev.overpass-api.de/overpass-doc/en/preface/commons.html",
  attribution: OSM_ATTRIBUTION,
  attributionRequired: true,
  legalBasis:
    "Results are OpenStreetMap data under ODbL 1.0; every response carries the project's own " +
    "copyright notice in osm3s.copyright, and attribution is rendered next to the results. " +
    "USAGE POLICY, read 2026-09-01 at https://dev.overpass-api.de/overpass-doc/en/preface/commons.html: " +
    "about 30,000 daily users share the two servers behind overpass-api.de; the published " +
    "guideline is 'a maximum of about 10000 requests per day' and under 1 GB of download per " +
    "day; rate-limit refusals are HTTP 429 and resource refusals HTTP 504; an undeclared query " +
    "gets 180 seconds and 512 MiB by default, so this tool declares " +
    `[timeout:${QUERY_TIMEOUT_SECONDS}] and a 32 MiB maxsize on every query. ` +
    "THE POLICY NAMES OUR CASE AS PROBLEMATIC: it lists 'setting up an app for more than just " +
    "OSM mappers and relying on the public instances as backend' among examples of problematic " +
    "behaviour, and says that for that case 'only running your own instance sustainably serves " +
    "your mission'. That is recorded here rather than argued away. The mitigations are: this " +
    "row seeds disabled so an operator decides; the ceilings below are a small fraction of the " +
    "published guideline; identical queries share one cached upstream call across all readers; " +
    "every submitted query is bounded by a global [bbox:] of at most 25,000 km2 and re-emitted " +
    "from a parsed structure so no user-supplied syntax reaches the server; and the tool page " +
    "points readers at overpass-turbo for exploratory work, which runs from their own browser " +
    "against their own rate-limit identity. The durable answer is our own Overpass instance, " +
    "which the project documents and recommends for this case. No access control exists on the " +
    "endpoint and none is circumvented; we submit one documented API request per user action " +
    "and crawl nothing. NOT A LEGAL OPINION.",
  baseUrl: "https://overpass-api.de",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  /** Well below the ~10k/day guideline; repeat queries hit the shared cache. */
  perUserQuota: 2,
  globalCeiling: 4,
  windowSeconds: 60,
  /** Above the declared 25s query timeout, with room for the response to transfer. */
  timeoutMs: 30_000,
  /** OSM data is minutes old anyway; resubmitting the same query costs one call. */
  cacheTtlSeconds: 300,
  staleWhileRevalidateSeconds: 900,
  enabled: false,
  status: "draft" as const,
  notes:
    "Endpoint and usage policy confirmed 2026-09-01 against api/status and the Overpass API " +
    "User's Manual. READ THE legal_basis BEFORE ENABLING: the operators' own policy names " +
    "'an app relying on the public instances as backend' as problematic behaviour and " +
    "recommends self-hosting for that case. Set enabled = true and status = 'published' to " +
    "bring /toolbench/overpass-builder up; until then the tool renders its disabled state and " +
    "makes no request.",
};

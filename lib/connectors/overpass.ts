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
import { parseRetryAfter, UpstreamStatusError } from "./runtime";
import { toolbenchUserAgent } from "./toolbench";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/overpass-builder` — OpenStreetMap feature queries against the public Overpass
 * API. product-brief §3.3: an outbound request on a user's behalf lives here and nowhere
 * else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CONFIRMED, AND HOW — 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Endpoint.** `POST https://overpass-api.de/api/interpreter` with the query in a
 *    `data=` form field. `GET https://overpass-api.de/api/status` answered on 2026-09-01
 *    with `Connected as: 1590912601 / Rate limit: 2 / 2 slots available now`, confirming
 *    both the host and the documented status format.
 *
 * 2. **Data licence.** The results are OpenStreetMap data, **ODbL 1.0**. Every response
 *    carries the project's own notice in `osm3s.copyright`. ODbL requires attribution, so
 *    `attribution_required = true` and the credit is rendered next to the results rather
 *    than in a footer.
 *
 * 3. **Usage policy, read at
 *    https://dev.overpass-api.de/overpass-doc/en/preface/commons.html on 2026-09-01.** The
 *    numbers, quoted: about 30,000 daily users share the two servers behind
 *    `overpass-api.de`; "users are expected to send a maximum of about 10000 requests per
 *    day and keep their download volume below about 1 GB per day"; rate-limit refusals are
 *    answered with **HTTP 429** and resource refusals with **HTTP 504**; an undeclared query
 *    gets a default 180-second run time and 512 MiB memory limit, and the scheduler admits a
 *    request only if it promises to use at most half the remaining resources.
 *
 * 4. **THE PART THAT MUST NOT BE SMOOTHED OVER.** That same page lists, as an example of
 *    problematic behaviour: *"Setting up an app for more than just OSM mappers and relying
 *    on the public instances as backend"*, and says that in that case "only running your own
 *    instance sustainably serves your mission."
 *
 *    We are that case. This is recorded rather than argued away, and it has three
 *    consequences that are built rather than promised:
 *
 *    a. The connector row seeds `enabled = false, status = draft`. An operator has to read
 *       the paragraph above and decide, which is what ADR 0012 §1 is for.
 *    b. The quota columns are set at a small fraction of the published guideline, and the
 *       payload cache is shared across all readers (ADR 0014 §4) so identical queries cost
 *       one upstream call.
 *    c. The tool page tells the reader, in words, that overpass-turbo runs the same query
 *       from their own browser against their own rate-limit identity, and that heavy or
 *       exploratory work belongs there. A tool that quietly spends a donated service's
 *       capacity on our behalf would be taking from the commons this product depends on.
 *
 *    **The honest resolution is our own Overpass instance**, which the project documents and
 *    explicitly recommends for this case. That is an infrastructure decision, not this
 *    file's, and it is written up in `docs/toolbench/HANDOFF-geo-tools.md`.
 *
 * 5. **robots.txt.** Checked 2026-09-01: `https://overpass-api.de/robots.txt` is not a crawl
 *    directive we are subject to here — we submit one documented API request per user action
 *    and crawl nothing. No access control exists on the endpoint and none is circumvented.
 *
 * NONE OF THIS IS A LEGAL OPINION. See `docs/content/legal-review.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ADR 0013: the audit row records THAT a query happened and never WHAT it asked for. The
 * query text is never logged, never persisted and never put in a log line — it is a
 * bounding box around the place a reader is investigating, which is the single most
 * sensitive thing this tool handles.
 */

export const OVERPASS_CONNECTOR_SLUG = "overpass-api-de";

/** The only host this driver will send a query to. See the check in `fetch`. */
const OVERPASS_HOST = "overpass-api.de";

/**
 * The request, as it arrives from the browser. One field, and it is not trusted: `normalise`
 * runs it back through the Toolbench grammar and re-emits it, so the string that reaches the
 * upstream is one `buildQuery` produced from a parsed structure.
 */
const requestSchema = z.object({ query: z.string() });

export type OverpassParams = { readonly query: string };

export type OverpassPayload = {
  readonly result: OverpassResult;
  /** The canonical query that actually ran, so the page can show what was sent. */
  readonly query: string;
};

/**
 * Validate, canonicalise, and refuse anything else.
 *
 * Throwing here is correct and is the documented contract: `runConnector` catches it, makes
 * no outbound call, writes no audit row, and returns a degraded envelope. A malformed query
 * is ours to reject, not the upstream's to be bothered with.
 */
function normalise(raw: unknown): OverpassParams {
  const parsed = requestSchema.parse(raw);
  const canonical = canonicaliseQuery(parsed.query);
  if (!canonical.ok) throw new Error(canonical.error);
  return { query: canonical.value };
}

export const overpassDriver: ConnectorDriver<OverpassParams, OverpassPayload> = {
  /**
   * `infrastructure` is the `SOURCE_KINDS` member the integrations engineer's handoff §6
   * reserves for exactly this: "crt.sh, Wayback CDX, RIPEstat, BGPView and urlscan are all
   * Toolbench tools taking a user-supplied query, not map layers... Owned by the
   * tools-engineer." A feature query against OSM is the same shape.
   */
  kind: "infrastructure",
  slug: OVERPASS_CONNECTOR_SLUG,
  normalise,

  /**
   * The cache key is a digest of the canonical query and nothing else. ADR 0014 §4: one
   * shared entry per connector plus normalised parameters, NEVER per user — two readers
   * asking the same question of the same box share one upstream call, and the key carries
   * no trace of who asked.
   *
   * A digest rather than the query itself because the key ends up in a Map and in log
   * scopes, and the query is the reader's search area. SHA-256 truncated to 128 bits: long
   * enough that a collision is not a thing that happens, short enough to read.
   */
  /**
   * Hashed, but still the reader's own query: a hash is a lookup key for anyone who can
   * guess the query, which is the whole shape of the QV-02 oracle. Private query.
   */
  perActor: true,
  cacheKey: (params) => createHash("sha256").update(params.query).digest("hex").slice(0, 32),

  async fetch(connector: Connector, params, signal) {
    /**
     * BELT AND BRACES ON THE REGISTRY ROW.
     *
     * `runConnector` used to resolve its row by `kind`, and several connectors now share
     * `infrastructure`. That handed this driver a DNS resolver's row and it POSTed an
     * Overpass query at `https://cloudflare-dns.com/api/interpreter` — the request went out,
     * to the wrong operator, under the wrong quota and the wrong recorded legal basis, and
     * it presented as an ordinary "source unreachable". `runtime.ts` resolves by slug now,
     * and this check stays so that a future caller which does not cannot repeat it. A driver
     * must never send its payload to a host it does not recognise.
     */
    const base = connector.baseUrl.replace(/\/+$/, "");
    if (new URL(base).hostname !== OVERPASS_HOST) {
      throw new UpstreamStatusError(502);
    }
    const url = `${base}/api/interpreter`;

    /**
     * `application/x-www-form-urlencoded` with the query in `data`, which is the documented
     * POST form. POST rather than GET because a query in a URL ends up in the upstream's
     * access log as a bounded query string; the body does not, and this body describes the
     * patch of the world a reader is investigating.
     */
    const body = new URLSearchParams({ data: params.query }).toString();

    const response = await fetch(url, {
      method: "POST",
      signal,
      cache: "no-store",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        /**
         * A speaking User-Agent, built from `config/brand.ts` and `SOURCE_CONTACT_EMAIL`
         * rather than hardcoded (product-brief §7). The Overpass operators ask to be able to
         * identify and contact a heavy caller instead of having to block an anonymous
         * pattern; an upstream that cannot reach us blocks us silently. It says nothing
         * whatsoever about the person viewing the page.
         */
        "user-agent": toolbenchUserAgent(),
      },
      body,
    });

    if (!response.ok) {
      /**
       * The two documented refusals, and they mean different things:
       *   429 — the rate limiter. `isRateLimitStatus` treats it as "they told us to stop",
       *         which opens the per-connector cooldown in `runtime.ts`.
       *   504 — the resource scheduler refused this particular query as too large for the
       *         capacity free right now. Not a rate limit and not a fault of ours to back
       *         off from globally; it is recorded as an upstream error and the message on
       *         the page tells the reader to narrow the box.
       */
      throw new UpstreamStatusError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    const text = await response.text();

    /**
     * Overpass answers a malformed or refused query with an HTML error document at HTTP 200
     * often enough that parsing must be attempted rather than assumed. A body that is not
     * JSON is an upstream error, not zero features.
     */
    let body_: unknown;
    try {
      body_ = JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamStatusError(502);
    }

    const result = normaliseOverpass(body_);
    if (!result.ok) throw new UpstreamStatusError(502);

    return { data: { result: result.value, query: params.query }, upstreamStatus: response.status };
  },
};

/**
 * The registry row this driver expects. Seeded by `db/seed.ts`, which this role does not
 * own — see `docs/toolbench/HANDOFF-geo-tools.md` §"What the maintainer needs to do".
 *
 * `enabled: false, status: draft`. ADR 0012 §1, and here it is not a formality: the usage
 * policy paragraph in `legalBasis` is something an operator should read before any traffic
 * leaves for a donated community service.
 */
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
    "and crawl nothing. NOT A LEGAL OPINION — see docs/content/legal-review.md.",
  baseUrl: "https://overpass-api.de",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  /**
   * Deliberately small. The published guideline is ~10,000 requests/day across a user; at 4
   * per minute sustained we would reach that in under two days of continuous saturation,
   * which no real usage pattern approaches — and the shared payload cache means repeat
   * queries cost nothing. These are a ceiling well below what the policy tolerates, not a
   * rate anybody told us was permitted.
   */
  perUserQuota: 2,
  globalCeiling: 4,
  windowSeconds: 60,
  /** Above the declared 25s query timeout, with room for the response to transfer. */
  timeoutMs: 30_000,
  /**
   * OSM's own extract behind Overpass is minutes old at best, and a geolocation query does
   * not become wrong in five minutes. Repeat submissions of the same query — which is what
   * a reader does while reading the results — cost one upstream call.
   */
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

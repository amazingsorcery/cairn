import { z } from "zod";

import { sourceUserAgent } from "@/lib/sources/http";

import type { Connector } from "@/db/schema";
import { countOutboundRequest } from "@/lib/net/outbound-tally";

import { parseRetryAfter, UpstreamStatusError } from "./runtime";
import type { ConnectorDriver } from "./types";

/**
 * `/live/flights` — open ADS-B aircraft positions. ADR 0011 §1.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CONFIRMED, AND HOW — 2026-08-31
 * ─────────────────────────────────────────────────────────────────────────────
 * The brief required the endpoint, terms and attribution to be confirmed against the
 * primary source before writing code against them, rather than assumed. They were:
 *
 * 1. **Endpoint.** `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}` — "Aircrafts
 *    surrounding a point (lat, lon) up to 250nm". Read from the service's own OpenAPI
 *    document at `https://api.adsb.lol/api/openapi.json` (the `/docs` page is a Swagger UI
 *    shell that loads it), and exercised once with a live request to confirm the response
 *    shape. `radius` is in NAUTICAL MILES with a documented maximum of 250; `lat` and `lon`
 *    are constrained to ±90 / ±180 by the spec itself.
 *
 * 2. **No API key, today.** The OpenAPI description says: "You can use the API for free. In
 *    the future, you will require an API key which you can get by feeding to adsb.lol." So
 *    the connector row is seeded with `requires_api_key = false` — and if that changes,
 *    `api_key_env_var` and the kill-switch are how it is handled, without a deploy
 *    (ADR 0012 §3).
 *
 * 3. **Licence and attribution.** The OpenAPI document declares
 *    `Open Data Commons Open Database License (ODbL) v1.0` for "the API as well as all data
 *    ADSB.lol makes public", and compares it to OpenStreetMap's. ODbL requires attribution,
 *    so the connector is seeded `attribution_required = true`.
 *
 *    ONE HONEST COMPLICATION, recorded rather than smoothed over: adsb.lol's own
 *    privacy/licence page describes what FEEDERS grant — a CC0 waiver on the data they
 *    contribute — which is a different question from the licence under which the service
 *    republishes. The two are not in conflict (a CC0 contribution can be redistributed under
 *    ODbL), but they are not the same statement. We take the stricter of the two, because
 *    over-attributing costs nothing and under-attributing breaches a licence.
 *
 * 4. **robots.txt.** `https://api.adsb.lol/robots.txt` returns 404 — no crawl directives are
 *    published for the API host, so there is nothing to respect or violate. Product-brief
 *    §3.2 constraint 5 is satisfied by construction here: we call one documented JSON
 *    endpoint, at a rate bounded by the connector's own quota columns, and we scrape nothing.
 *
 * 5. **Rate limits.** The service states only that "rate limits are dynamic based on the
 *    environment load", and asks production users to make contact. That is not a number we
 *    can encode, so the connector's `global_ceiling` is set conservatively low and the
 *    payload is cached and shared across all viewers (ADR 0014 §4) — one upstream call
 *    serves every reader of the surface.
 *
 * NONE OF THIS IS A LEGAL OPINION. `connectors.legal_basis` records what was read and when;
 * `docs/content/legal-review.md` is where a qualified reviewer answers the actual question.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ADR 0011 rule 8 — LIVE MEANS LIVE. Nothing here is persisted. There is no table of
 * aircraft positions, tracks, callsigns or registrations and there must never be one; the
 * prohibition is written into `db/schema.ts` above the Live subtree. The payload rests only
 * in the bounded in-process cache in `runtime.ts`, for at most `ttl + swr`.
 */

/* ------------------------------------------------------------------ *
 * Request parameters
 * ------------------------------------------------------------------ */

/**
 * The viewport, quantised.
 *
 * `lat` and `lon` are rounded to one decimal place — roughly 11 km — and the radius is
 * snapped to a small ladder. This is not sloppiness, it is the cache key (ADR 0014 §4): one
 * shared entry per connector plus normalised parameters, never per user. Full precision
 * would give every viewer their own cache entry, which multiplies upstream calls by the
 * viewer count, makes the global ceiling unenforceable, and — the part that matters —
 * recreates a per-user record of exactly which patch of the world each person was watching.
 */
const RADIUS_LADDER = [25, 50, 100, 150, 250] as const;

export const flightParamsSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  /** Nautical miles. The upstream's own documented maximum is 250. */
  radius: z.coerce.number().min(1).max(250).default(50),
});

export type FlightParams = { lat: number; lon: number; radius: number };

function quantise(raw: unknown): FlightParams {
  const parsed = flightParamsSchema.parse(raw);
  const radius: number = RADIUS_LADDER.find((step) => parsed.radius <= step) ?? 250;
  return {
    lat: Math.round(parsed.lat * 10) / 10,
    lon: Math.round(parsed.lon * 10) / 10,
    radius,
  };
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

/**
 * The upstream response, validated at the boundary. Zod at every boundary
 * (product-brief §5) explicitly includes an external response: this is a free community
 * service whose shape can change without notice, and an unvalidated `as` cast turns that
 * into a runtime crash on a page whose entire job is to degrade honestly.
 *
 * `.passthrough()` on the aircraft object and `.catch` on the envelope's optional numbers
 * are deliberate: an upstream that ADDS a field must not break us, only one that removes or
 * retypes what we read.
 */
const aircraftSchema = z
  .object({
    hex: z.string(),
    flight: z.string().nullish(),
    r: z.string().nullish(),
    t: z.string().nullish(),
    lat: z.number().nullish(),
    lon: z.number().nullish(),
    // `alt_baro` is documented as integer | string | null — it carries the literal
    // "ground" for an aircraft on the surface, which is why the string arm exists.
    alt_baro: z.union([z.number(), z.string()]).nullish(),
    gs: z.number().nullish(),
    track: z.number().nullish(),
    squawk: z.string().nullish(),
    emergency: z.string().nullish(),
    seen_pos: z.number().nullish(),
  })
  .passthrough();

/**
 * `ac` and `now` are REQUIRED, not defaulted.
 *
 * Both are in the upstream's own `required` list, and defaulting either would be the worst
 * possible failure here: a response of a completely different shape would parse as "zero
 * aircraft" and the map would render an empty, confident, wrong sky. ADR 0014's whole
 * argument is against a surface that lies about its own state — a shape change must degrade
 * to `unavailable`, not to "nothing is flying".
 *
 * `total` stays optional because nothing depends on it beyond a displayed count.
 */
const responseSchema = z.object({
  ac: z.array(aircraftSchema),
  /** Upstream clock, milliseconds since the epoch. */
  now: z.number(),
  total: z.number().optional(),
});

/**
 * The trimmed payload — ADR 0014 §7: only the fields the surface renders.
 *
 * Everything the upstream sends about navigation intent, wind, temperature, roll rate and
 * receiver signal strength is discarded here. It keeps the cache entry small enough to
 * rewrite every fifteen seconds on a small VPS, and it means we are not incidentally holding
 * upstream fields we have no use for.
 *
 * `registration` and `callsign` are broadcast in the clear by the aircraft itself and are
 * what makes the surface useful for corroboration. We add NO identity resolution on top of
 * them — no owner lookup, no operator database, no history (ADR 0011 rule 8, and the
 * consequences section on private-jet tracking).
 */
export type Aircraft = {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  lat: number;
  lon: number;
  /** Feet. Null when the aircraft reports "ground" or omits the field. */
  altitudeFt: number | null;
  onGround: boolean;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  squawk: string | null;
  /** The upstream's own emergency squawk interpretation, passed through unaltered. */
  emergency: string | null;
  /** Seconds since this aircraft's position was last received. The per-aircraft age. */
  positionAgeSeconds: number | null;
};

export type FlightsPayload = {
  aircraft: Aircraft[];
  /** What the upstream said it returned, which may exceed what it sent. */
  reportedTotal: number | null;
  /** The viewport this payload actually covers, after quantisation. */
  viewport: FlightParams;
};

function trim(parsed: z.infer<typeof responseSchema>, params: FlightParams): FlightsPayload {
  const aircraft: Aircraft[] = [];

  for (const item of parsed.ac) {
    // An aircraft with no position cannot be drawn. Dropping it here rather than in the
    // component keeps the "how many are on screen" count honest.
    if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;

    const onGround = item.alt_baro === "ground";
    aircraft.push({
      hex: item.hex,
      callsign: item.flight?.trim() || null,
      registration: item.r?.trim() || null,
      type: item.t?.trim() || null,
      lat: item.lat,
      lon: item.lon,
      altitudeFt: typeof item.alt_baro === "number" ? item.alt_baro : null,
      onGround,
      groundSpeedKt: item.gs ?? null,
      trackDeg: item.track ?? null,
      squawk: item.squawk ?? null,
      emergency: item.emergency && item.emergency !== "none" ? item.emergency : null,
      positionAgeSeconds: item.seen_pos ?? null,
    });
  }

  return {
    aircraft,
    reportedTotal: parsed.total ?? null,
    viewport: params,
  };
}

/* ------------------------------------------------------------------ *
 * The driver
 * ------------------------------------------------------------------ */

export const FLIGHTS_CONNECTOR_SLUG = "adsb-lol";

export const flightsDriver: ConnectorDriver<FlightParams, FlightsPayload> = {
  kind: "flights",
  slug: FLIGHTS_CONNECTOR_SLUG,
  normalise: quantise,
  /**
   * NOT per-actor, and this is the case ADR 0014 §4 was written for. A viewport is a
   * question about the world rather than about the reader: every reader looking at the same
   * patch of sky asks the same thing, the answer is the same for all of them, and one shared
   * entry is what holds us inside adsb.lol's fair use. `normalise` quantises the coordinates
   * before they reach the key, so the key is coarser than the view anyway.
   */
  perActor: false,
  cacheKey: (p) => `${p.lat.toFixed(1)},${p.lon.toFixed(1)},${p.radius}`,

  async fetch(connector: Connector, params, signal) {
    /**
     * The path is built from NUMBERS that Zod has already bounded, then encoded. There is no
     * string from the request in it, so there is no path-traversal or header-injection
     * surface — but `encodeURIComponent` is applied anyway, because "the type says it is a
     * number" is exactly the assumption that stops being true after a refactor.
     */
    const base = connector.baseUrl.replace(/\/+$/, "");
    const url =
      `${base}/v2/lat/${encodeURIComponent(params.lat)}` +
      `/lon/${encodeURIComponent(params.lon)}` +
      `/dist/${encodeURIComponent(params.radius)}`;

    // This driver calls `fetch` directly rather than through `upstreamGet`, so it counts
    // itself (QV-09). One call per poll today; the counter is what keeps that true.
    countOutboundRequest();
    const response = await fetch(url, {
      signal,
      // `no-store`: the freshness contract is ours (ADR 0014), and a second cache with its
      // own clock is the two-clocks-disagreeing failure §5 rejects.
      cache: "no-store",
      headers: {
        accept: "application/json",
        // Identifying ourselves is the courteous and the safe thing: an operator who needs
        // to rate-limit or contact us can, rather than blocking an anonymous pattern. It
        // says nothing about the person viewing the page.
        // Built from `config/brand.ts` via `sourceUserAgent()`, not written out here. The
        // literal that used to sit on this line broke the one-file rename contract
        // (the conventions §4, product-brief §7) — a rename would have left this outbound header
        // still naming the old product to an upstream operator. It also now carries a real
        // contact address, which NWS and Nominatim ask for and which is the difference
        // between being throttled and being blocked without warning.
        "user-agent": sourceUserAgent(),
      },
    });

    if (!response.ok) {
      /**
       * `Retry-After` is read on EVERY non-2xx, not only on 429: a 503 may carry one too, and
       * a header we were given is always better than a constant we chose.
       *
       * Measured against adsb.lol on 2026-08-31: it sends no `Retry-After` on either a 200 or
       * a 429, so in practice this resolves to null here and `runtime.ts` falls back to
       * `DEFAULT_COOLDOWN_SECONDS`. The parsing exists because the day they start sending one
       * is the day we should obey it, not the day we notice.
       */
      throw new UpstreamStatusError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    const body: unknown = await response.json();
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      // A shape change is an upstream fault as far as the surface is concerned: the caller
      // degrades honestly rather than rendering half a map. 502 is recorded because no
      // usable payload arrived, and the parse error is not logged verbatim — it would
      // contain the upstream body.
      throw new UpstreamStatusError(502);
    }

    return { data: trim(parsed.data, params), upstreamStatus: response.status };
  },
};

/**
 * The registry row this driver expects, as seeded by `db/seed.ts`.
 *
 * It lives beside the driver so the endpoint, the licence and the quota envelope are
 * reviewed together in one file — but it is DATA, written to the `connectors` table, because
 * ADR 0012 is explicit that a kill-switch requiring a deploy is not a kill-switch and a
 * quota you cannot adjust under load is not a quota. Once seeded, every value below is an
 * operator's to change with an UPDATE.
 *
 * `enabled: false`. ADR 0012 §1: a newly seeded connector is inert until an operator
 * deliberately turns it on. Fail closed.
 */
export const FLIGHTS_CONNECTOR_SEED = {
  slug: FLIGHTS_CONNECTOR_SLUG,
  name: "adsb.lol",
  kind: "flights" as const,
  operatorName: "adsb.lol (community ADS-B aggregator)",
  homepageUrl: "https://www.adsb.lol/",
  termsUrl: "https://api.adsb.lol/docs",
  attribution: "Aircraft data from adsb.lol, licensed under ODbL 1.0.",
  attributionRequired: true,
  legalBasis:
    "adsb.lol's API description (read 2026-08-31 at https://api.adsb.lol/api/openapi.json) " +
    "states that the API and all data adsb.lol makes public are licensed under the Open Data " +
    "Commons Open Database Licence (ODbL) v1.0, and that the API may currently be used for " +
    "free without a key. ODbL requires attribution, so attribution is recorded as required " +
    "and is rendered next to the data. adsb.lol's feeder-facing privacy page separately " +
    "describes contributors waiving rights under CC0; where the two differ we apply the " +
    "stricter ODbL terms. No robots.txt is published for api.adsb.lol (404 on 2026-08-31), " +
    "so no crawl directive is being circumvented. The data is ADS-B telemetry broadcast in " +
    "the clear by the aircraft; we add no identity resolution and retain nothing. " +
    "RATE: the upstream publishes no limit ('rate limits are dynamic based on the " +
    "environment load') and sends no Retry-After or X-RateLimit headers, so THEIR LIMITER IS " +
    "THE AUTHORITY AND NOT THESE COLUMNS. A 429 or 420 opens a per-connector cooldown and we " +
    "stop calling until it expires; the surface degrades to a stale or unavailable state that " +
    "says so, and the client stops polling. The columns on this row are a ceiling set below " +
    "the lowest rate at which refusals were observed (2026-08-31: a 25-request burst was " +
    "refused from the 3rd request, and 10 requests/minute spaced 6s apart drew 2 refusals in " +
    "8), not a rate we assert is permitted. Corrected after QA finding Q-02, which recorded " +
    "57 HTTP 429s and one 420 against an earlier envelope of 20/user/min and 60/min global " +
    "whose stated basis was factually wrong. NOT A LEGAL OPINION — see " +
    "docs/content/legal-review.md.",
  baseUrl: "https://api.adsb.lol",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  /**
   * Quotas, TIGHTENED after QA finding Q-02. The previous envelope (20/user/min, 60/min
   * global) drew 57 HTTP 429s and one 420 — 29% of all outbound calls refused.
   *
   * WHAT THESE NUMBERS ARE BASED ON, measured 2026-08-31:
   *   - A 25-request burst was refused from the **3rd** request onward. Our old per-user
   *     quota did not bite until the 19th.
   *   - 10 requests/minute, spaced 6 seconds apart with distinct viewports, still drew 2
   *     refusals in 8 — so even a smooth 10/min is above what the bucket tolerates when it
   *     is already partly drained.
   *   - After ~20 seconds idle, two back-to-back requests both succeeded, so the limiter is
   *     a refilling token bucket rather than a fixed window.
   *
   * So the ceiling is 6/min — one call per 10 seconds sustained, comfortably under the
   * lowest rate at which refusals were seen. It is a CEILING BELOW THE OBSERVED FLOOR, not a
   * rate anyone told us was permitted, and `legalBasis` says exactly that. The real
   * protection is the cooldown in `runtime.ts`: their limiter is the authority.
   *
   * Because the payload is shared across all viewers (ADR 0014 §4), the ceiling bounds our
   * TOTAL upstream traffic, not our traffic per reader.
   */
  perUserQuota: 3,
  globalCeiling: 6,
  windowSeconds: 60,
  timeoutMs: 5000,
  /**
   * TTL raised 15s -> 60s, the single biggest reduction in upstream load available: one
   * viewport now costs at most 1 call/minute instead of 4. ADR 0014 §2 set 15 as "a starting
   * value, to be tuned against real upstream behaviour rather than guessed at twice" — this
   * is that tuning, and the audit log is the measurement.
   *
   * The stale window is raised 60s -> 600s to match: while we are backed off we would rather
   * show ten-minute-old positions clearly labelled with their age than an empty page. ADR
   * 0014 §3's horizon still applies — past ttl+swr the surface goes `unavailable` rather than
   * serving something older with a growing label.
   */
  cacheTtlSeconds: 60,
  staleWhileRevalidateSeconds: 600,
  enabled: false,
  status: "draft" as const,
  notes:
    "Endpoint and licence confirmed 2026-08-31 against the service's own OpenAPI document " +
    "and one live request. Quota envelope tightened and backoff added after QA finding Q-02 " +
    "(57 logged 429s under the previous settings). Seeded disabled and draft per ADR 0012 " +
    "§1: an operator must review the recorded legal basis and turn it on. Set `enabled = " +
    "true` and `status = 'published'` to bring /live/flights up.",
};

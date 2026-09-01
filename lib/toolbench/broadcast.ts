import { z } from "zod";

import { fail, ok, type ToolResult } from "./result";

/**
 * The Broadcast Finder's pure half: the search filters, the upstream schema, and the
 * classification of a stream URL into "the browser can play this" and "it cannot".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT BUILT ON `lib/sources/radio-browser.ts`
 * ─────────────────────────────────────────────────────────────────────────────
 * That adapter is correct for the map and wrong for a finder, and the integrations
 * engineer measured by how much (`docs/sources/HANDOFF.md` §7b, 2026-08-31):
 *
 *   58,374 stations in the catalogue
 *   52,999 working
 *   12,413 working AND geolocated — 23.4%
 *      500 served by the map adapter (top 500 by clicks) — under 1%
 *
 * The adapter filters `has_geo_info=true` because a station with no coordinates cannot be
 * drawn, and caps at 500 because a map does not need more. A finder built on it would
 * search under one percent of the catalogue while looking complete.
 *
 * Re-confirmed here on 2026-09-01 with a concrete case: a search for Dutch-language news
 * stations in NL returns **NPO Radio 1 and BNR Nieuwsradio with `geo_lat: null`**. The two
 * most obvious answers to that query are invisible to the map adapter. A reader would
 * conclude the Netherlands has no national news radio.
 *
 * So this queries the search endpoint directly, without the geo filter, through the
 * connector seam — which is also the right architectural home, because a finder sends a
 * *user's* query outbound and that is `lib/connectors/` (per-user quota, audit log,
 * kill-switch), not the shared user-less poll `lib/sources/` is built for.
 *
 * The **terms** work is reused wholesale from `docs/sources/radio-browser.md`: public-domain
 * dedication, a speaking User-Agent, the `HOST_PATTERN` guard on any hostname that reaches a
 * URL, and the decision NOT to send the `/json/url` click-tracking request. See
 * `lib/connectors/broadcast.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/**
 * How the upstream may order results. An allowlist, not a passthrough: `order` is
 * interpolated into an upstream query string, and an operator-controlled allowlist is the
 * same discipline `usgs-earthquakes` applies to `USGS_QUAKE_FEED`.
 */
export const SEARCH_ORDERS = ["votes", "clickcount", "name", "bitrate", "lastcheckok"] as const;
export type SearchOrder = (typeof SEARCH_ORDERS)[number];

export const ORDER_LABELS: Readonly<Record<SearchOrder, string>> = {
  votes: "Community votes",
  clickcount: "Recent listeners",
  name: "Station name",
  bitrate: "Bitrate",
  lastcheckok: "Last known working",
};

/** A generous page for a finder, and far below anything that strains a volunteer mirror. */
export const MAX_RESULTS = 200;
export const DEFAULT_RESULTS = 60;

const textField = z
  .string()
  .trim()
  .max(60, "Keep search terms under 60 characters.")
  // Control characters have no business in a search term and would end up in a URL.
  .regex(/^[^\u0000-\u001f\u007f]*$/u, "That contains a character this search cannot send.");

export const broadcastFilterSchema = z.object({
  /** Station name, matched as a substring by the upstream. */
  name: textField.default(""),
  /** ISO 3166-1 alpha-2. The upstream's own `countrycode` parameter. */
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/, "A country code is two letters, such as NL or UA.")
    .default(""),
  /** Region within a country, as the catalogue spells it. Free text upstream. */
  state: textField.default(""),
  /** Language name in English, as the catalogue spells it: "dutch", "ukrainian". */
  language: textField.default(""),
  /** One catalogue tag: "news", "talk", "traffic". */
  tag: textField.default(""),
  order: z.enum(SEARCH_ORDERS).default("votes"),
  limit: z.coerce.number().int().min(1).max(MAX_RESULTS).default(DEFAULT_RESULTS),
  /**
   * Whether to ask the upstream to hide stations its own checker last found broken.
   * Default on; a reader can turn it off, because a station that failed the project's check
   * an hour ago is not necessarily off the air, and for a breaking-news search that
   * difference matters.
   */
  hideBroken: z.boolean().default(true),
});

export type BroadcastFilters = z.infer<typeof broadcastFilterSchema>;

/** True when the reader has given the search something to work with. */
export function hasAnyFilter(filters: BroadcastFilters): boolean {
  return (
    filters.name.length > 0 ||
    filters.countryCode.length > 0 ||
    filters.state.length > 0 ||
    filters.language.length > 0 ||
    filters.tag.length > 0
  );
}

/**
 * Turn filters into the upstream's own query parameters.
 *
 * NO `has_geo_info`. That single omission is the difference between 1% of the catalogue and
 * all of it, and it is the reason this module exists.
 *
 * Every value goes through `URLSearchParams`, which percent-encodes it, and every value has
 * already been bounded by the schema above. `order` is an allowlist member. There is no path
 * by which a reader's text becomes URL syntax.
 */
export function buildSearchParams(filters: BroadcastFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.name) params.set("name", filters.name);
  if (filters.countryCode) params.set("countrycode", filters.countryCode);
  if (filters.state) params.set("state", filters.state);
  if (filters.language) params.set("language", filters.language.toLowerCase());
  if (filters.tag) params.set("tag", filters.tag.toLowerCase());
  params.set("order", filters.order);
  // Name ascending reads naturally; every other ordering is "most first".
  params.set("reverse", filters.order === "name" ? "false" : "true");
  params.set("hidebroken", filters.hideBroken ? "true" : "false");
  params.set("limit", String(filters.limit));
  return params;
}

/**
 * A stable key for the shared payload cache. Must encode the query and nothing about who
 * asked — ADR 0014 §4.
 */
export function filtersCacheKey(filters: BroadcastFilters): string {
  return buildSearchParams(filters).toString();
}

/* ------------------------------------------------------------------ *
 * The upstream response
 * ------------------------------------------------------------------ */

/**
 * The endpoint returns a bare array, so there is no upstream timestamp; the freshness a
 * reader needs is per station, in `lastcheckoktime_iso8601`, which is when the project's own
 * checker last found the stream playable.
 *
 * `.passthrough()` and `nullish()` throughout: the catalogue is community-edited and fields
 * are missing constantly. An upstream that ADDS a field must not break us.
 */
const stationSchema = z
  .object({
    stationuuid: z.string(),
    name: z.string(),
    url: z.string().nullish(),
    url_resolved: z.string().nullish(),
    homepage: z.string().nullish(),
    tags: z.string().nullish(),
    country: z.string().nullish(),
    countrycode: z.string().nullish(),
    state: z.string().nullish(),
    language: z.string().nullish(),
    codec: z.string().nullish(),
    bitrate: z.number().nullish(),
    hls: z.number().nullish(),
    lastcheckok: z.number().nullish(),
    lastcheckoktime_iso8601: z.string().nullish(),
    votes: z.number().nullish(),
    clickcount: z.number().nullish(),
    geo_lat: z.number().nullish(),
    geo_long: z.number().nullish(),
  })
  .passthrough();

export const broadcastResponseSchema = z.array(stationSchema);

export interface BroadcastStation {
  readonly uuid: string;
  readonly name: string;
  /**
   * The stream the CLIENT connects to directly. Our server never fetches it — product-brief
   * §2b. If this URL ever becomes a path on our own origin, the product has started
   * rebroadcasting.
   */
  readonly streamUrl: string;
  /**
   * True when the stream URL is plain `http:`.
   *
   * MEASURED by the integrations engineer, 2026-08-31: **2,473 of 12,413 working geolocated
   * stations — about 20% — publish an `http:` URL.** A browser on our HTTPS page blocks
   * those as mixed content whatever our CSP says, so a play button on one fails silently.
   * Confirmed again on 2026-09-01: two of the top three Dutch news stations are `http:`.
   *
   * The UI must not offer a play button for these. It labels them and links out. Hiding a
   * fifth of the catalogue would be the same silent-incompleteness failure as the geo filter.
   */
  readonly isInsecureStream: boolean;
  /** HLS needs a player most browsers do not have natively; Safari does. */
  readonly isHls: boolean;
  readonly codec: string | null;
  readonly bitrateKbps: number | null;
  readonly homepage: string | null;
  readonly country: string | null;
  readonly countryCode: string | null;
  readonly state: string | null;
  readonly language: string | null;
  readonly tags: readonly string[];
  /** Whether the project's own checker last found the stream playable, and when. */
  readonly lastCheckOk: boolean;
  readonly lastCheckedAt: string | null;
  readonly votes: number | null;
  /** Present for only about a quarter of the catalogue. Absence is not a defect. */
  readonly latitude: number | null;
  readonly longitude: number | null;
}

/**
 * Only http(s) URLs are passed on. A `javascript:` or `data:` URL in a community-edited
 * catalogue is not a radio station, and this list is rendered into href and src attributes.
 */
export function safeStreamUrl(...candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      // Credentials in a stream URL would be rendered into the page and sent by the browser.
      if (parsed.username || parsed.password) continue;
      return parsed.toString();
    } catch {
      // Not a URL. Try the next candidate.
    }
  }
  return null;
}

/** The catalogue's tags are one comma-separated string. Split, trim, drop empties, cap. */
export function parseTags(raw: string | null | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 12);
}

export function normaliseBroadcast(raw: unknown): ToolResult<readonly BroadcastStation[]> {
  const parsed = broadcastResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "The station catalogue answered with something this tool does not recognise. Nothing is " +
        "shown rather than a half-parsed list.",
    );
  }

  const stations: BroadcastStation[] = [];
  for (const station of parsed.data) {
    // `url_resolved` has already followed playlist redirects, which saves the browser a hop.
    const streamUrl = safeStreamUrl(station.url_resolved, station.url);
    // A station we cannot hand the reader a playable link for is not a result.
    if (!streamUrl) continue;

    stations.push({
      uuid: station.stationuuid,
      name: station.name.trim() || "Unnamed station",
      streamUrl,
      isInsecureStream: streamUrl.startsWith("http://"),
      isHls: station.hls === 1,
      codec: station.codec?.trim() || null,
      bitrateKbps: typeof station.bitrate === "number" && station.bitrate > 0 ? station.bitrate : null,
      homepage: safeStreamUrl(station.homepage),
      country: station.country?.trim() || null,
      countryCode: station.countrycode?.trim().toUpperCase() || null,
      state: station.state?.trim() || null,
      language: station.language?.trim() || null,
      tags: parseTags(station.tags),
      lastCheckOk: station.lastcheckok === 1,
      lastCheckedAt: station.lastcheckoktime_iso8601 ?? null,
      votes: typeof station.votes === "number" ? station.votes : null,
      latitude: typeof station.geo_lat === "number" ? station.geo_lat : null,
      longitude: typeof station.geo_long === "number" ? station.geo_long : null,
    });
  }

  return ok(stations);
}

/** How many of a result set the browser cannot play, for the count the UI must show. */
export function countInsecure(stations: readonly BroadcastStation[]): number {
  return stations.filter((station) => station.isInsecureStream).length;
}

/**
 * Attribution. A public-domain dedication requires no credit; we render one anyway, because
 * a reader needs to know which catalogue asserted a station exists, and the project is
 * volunteer-run and deserves the traffic. Matches the string the map adapter renders.
 */
export const BROADCAST_ATTRIBUTION = "Station data from the Radio Browser community catalogue";
export const BROADCAST_ATTRIBUTION_URL = "https://www.radio-browser.info/";

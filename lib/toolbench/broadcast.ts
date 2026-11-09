import { z } from "zod";

import { fail, ok, type ToolResult } from "./result";

/**
 * Broadcast Finder's pure half: filters, upstream schema, stream URL classification.
 *
 * Not built on `lib/sources/radio-browser.ts`: the map adapter requires geo info and caps at
 * 500, which covers under 1% of the ~58k-station catalogue (e.g. NPO Radio 1 has no
 * coordinates). This queries the search endpoint via `lib/connectors/broadcast.ts` (per-user
 * quota, audit log), and doesn't send the `/json/url` click-tracking request.
 */

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/** Allowed upstream orderings (goes into the upstream query string). */
export const SEARCH_ORDERS = ["votes", "clickcount", "name", "bitrate", "lastcheckok"] as const;
export type SearchOrder = (typeof SEARCH_ORDERS)[number];

export const ORDER_LABELS: Readonly<Record<SearchOrder, string>> = {
  votes: "Community votes",
  clickcount: "Recent listeners",
  name: "Station name",
  bitrate: "Bitrate",
  lastcheckok: "Last known working",
};

/** Kept modest for a volunteer-run mirror. */
export const MAX_RESULTS = 200;
export const DEFAULT_RESULTS = 60;

const textField = z
  .string()
  .trim()
  .max(60, "Keep search terms under 60 characters.")
  // No control characters.
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
  /** Hide stations the upstream checker last found broken. Can be turned off (checks lag). */
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
 * Filters to upstream query params. Intentionally no `has_geo_info`. Values are bounded by
 * the schema and percent-encoded by `URLSearchParams`.
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

/** Shared cache key: encodes the query, never the caller. */
export function filtersCacheKey(filters: BroadcastFilters): string {
  return buildSearchParams(filters).toString();
}

/* ------------------------------------------------------------------ *
 * The upstream response
 * ------------------------------------------------------------------ */

/**
 * Bare array, so freshness is per station (`lastcheckoktime_iso8601`). Lenient
 * (`passthrough`, `nullish`) since the catalogue is community-edited.
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
  /** Fetched by the client directly; our server never relays media. */
  readonly streamUrl: string;
  /**
   * Plain `http:` stream (~20% of stations). Browsers block it as mixed content, so the UI
   * links out instead of offering a play button.
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
  /** Present for only about a quarter of the catalogue. */
  readonly latitude: number | null;
  readonly longitude: number | null;
}

/** First http(s) URL without credentials; these end up in href/src attributes. */
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
    // `url_resolved` has already followed playlist redirects.
    const streamUrl = safeStreamUrl(station.url_resolved, station.url);
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

/** Not required (public domain) but shown anyway. Matches the map adapter's string. */
export const BROADCAST_ATTRIBUTION = "Station data from the Radio Browser community catalogue";
export const BROADCAST_ATTRIBUTION_URL = "https://www.radio-browser.info/";

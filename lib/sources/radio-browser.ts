import { z } from "zod";

import {
  coordinatePair,
  healthcheckByFetch,
  parseWith,
  pollJson,
  type NormaliseOutcome,
  type PollAdapter,
} from "./adapter";
import type { SourceFeature, SourceResult } from "./types";

/**
 * Radio Browser — a community catalogue of internet radio stations, with coordinates.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — 2026-08-31. Full record in `docs/sources/radio-browser.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence      Public domain dedication by the project maintainer. The project's own info
 *              page states: "Data license: public domain, software license: GPL" and "I give
 *              all the rights I have at the accumulated data to the public domain."
 *              (github.com/segler-alex/radiobrowser, partials/info.html, read 2026-08-31.)
 *              NOTE THE PRECISION: the maintainer dedicates the rights *they have*. Station
 *              names, homepages and stream URLs are facts about third parties; the dedication
 *              covers the catalogue, and it does not and cannot license the audio.
 * Key          None.
 * User-Agent   Asked for explicitly: "Send a speaking http agent string (e.g. mycoolapp/1.4)".
 * Rate limit   Not published. Mirrors are volunteer-run, so the TTL is one hour — station
 *              metadata changes on the order of days, and product-brief §2b puts webcam-style
 *              metadata at ~1h.
 * Access ctrl  None circumvented. Documented public endpoints, no auth.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TWO THINGS WE DELIBERATELY DO NOT DO, both of which are the point of this adapter:
 *
 * 1. **We never touch the audio.** `streamUrl` is handed to the client, which connects to
 *    the station directly. Product-brief §2b: relaying audio through one VPS exhausts its
 *    bandwidth in hours and converts a linking site into a rebroadcasting one — a different
 *    legal posture entirely, and one the public-domain catalogue licence says nothing about,
 *    because the catalogue's licence is not the audio's licence.
 *
 * 2. **We never send the click-tracking request.** The API asks callers to "send /json/url
 *    requests for every click the user makes, this helps to mark stations as popular". For a
 *    normal media player that is a fair trade. Here it would tell a third party which station
 *    each of our readers opened — precisely the interest-graph leak product-brief §3.2
 *    constraint 4 forbids, for an audience that will not use a tool that leaks it. We take
 *    the data and decline the telemetry, and this comment exists so the omission reads as a
 *    decision rather than an oversight.
 */

/**
 * Documented server discovery: "Do a DNS-lookup of 'all.api.radio-browser.info'... Available
 * server names may change." We use the HTTP form of the same discovery rather than raw DNS —
 * it returns the same list, it works identically in a container with no DNS tooling, and it
 * respects the instruction not to hardcode one mirror. The example server the docs name is
 * the fallback for when discovery itself is down.
 */
const DISCOVERY_URL = "https://all.api.radio-browser.info/json/servers";
const FALLBACK_HOST = "de1.api.radio-browser.info";

/** Mirrors change rarely; re-discovering more often than hourly would be the rude thing. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Only stations with coordinates can appear on a map at all. */
const STATION_LIMIT = 500;

const serverSchema = z.array(z.object({ name: z.string() }).passthrough());

const globalForServers = globalThis as typeof globalThis & {
  __cairnRadioServers__?: { host: string; at: number };
};

/**
 * Hostnames from discovery are validated before they can reach a URL.
 *
 * This one matters more than most: the host comes from a remote response, and putting a
 * remote-controlled string into a server-side fetch is textbook SSRF — the risk ADR 0019
 * names as v2's top one. The pattern pins it to the project's own domain, so a compromised or
 * spoofed discovery response cannot redirect our worker anywhere else.
 */
const HOST_PATTERN = /^[a-z0-9-]+\.api\.radio-browser\.info$/;

export function pickServer(raw: unknown): string {
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) return FALLBACK_HOST;
  const hosts = Array.from(new Set(parsed.data.map((s) => s.name.toLowerCase()))).filter((name) =>
    HOST_PATTERN.test(name),
  );
  if (hosts.length === 0) return FALLBACK_HOST;
  // Spread load across mirrors rather than always hitting the first one. They are volunteer
  // machines; a client that always picks `de1` is why `de1` falls over.
  return hosts[Math.floor(Math.random() * hosts.length)] ?? FALLBACK_HOST;
}

/* ------------------------------------------------------------------ *
 * Upstream schema
 * ------------------------------------------------------------------ */

/**
 * The endpoint returns a bare ARRAY, not an envelope — so there is no upstream timestamp to
 * read and `observedAt` is our receive time. That is stated here because it is the one place
 * in this directory where `observedAt` is genuinely ours, and a reader of the freshness
 * display deserves to know the difference.
 */
const stationSchema = z
  .object({
    stationuuid: z.string(),
    name: z.string(),
    url: z.string().nullish(),
    url_resolved: z.string().nullish(),
    homepage: z.string().nullish(),
    favicon: z.string().nullish(),
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

export const radioBrowserResponseSchema = z.array(stationSchema);

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface RadioStationFeature extends SourceFeature {
  readonly kind: "radio";
  readonly properties: {
    readonly stationUuid: string;
    /**
     * The stream the CLIENT connects to directly. Never fetched by our server — see the
     * note at the top of this file. `url_resolved` is preferred because it has already
     * followed playlist redirects, which saves the browser a hop.
     */
    readonly streamUrl: string;
    /** Whether the stream is HLS, so the client can choose a player. 0/1 upstream. */
    readonly isHls: boolean;
    readonly codec: string | null;
    readonly bitrateKbps: number | null;
    readonly homepage: string | null;
    readonly country: string | null;
    readonly countryCode: string | null;
    readonly state: string | null;
    readonly language: string | null;
    /** Comma-separated upstream tag string, passed through as given. */
    readonly tags: string | null;
    /**
     * Whether the project's own checker last found the stream playable, and when. This is
     * the honest freshness signal for a link we are about to hand a reader.
     */
    readonly lastCheckOk: boolean;
    readonly lastCheckedAt: string | null;
    readonly clickCount: number | null;
  };
}

/** Only http(s) stream URLs are passed on. A `javascript:` or `data:` URL is not a radio. */
function safeStreamUrl(...candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
    } catch {
      // Not a URL. Try the next candidate.
    }
  }
  return null;
}

export function normaliseRadioBrowser(
  raw: unknown,
  receivedAt: Date = new Date(),
): NormaliseOutcome<RadioStationFeature> {
  const parsed = parseWith(radioBrowserResponseSchema, raw);
  if (!parsed.ok) return parsed;

  const features: RadioStationFeature[] = [];
  for (const station of parsed.data) {
    const position = coordinatePair(station.geo_long, station.geo_lat);
    if (!position) continue;

    // 0,0 is the Gulf of Guinea and is what a station gets when someone leaves the geo
    // fields at their default. A cluster of "radio stations" in the open ocean is the
    // signature of exactly that, so they are dropped.
    if (position.longitude === 0 && position.latitude === 0) continue;

    const streamUrl = safeStreamUrl(station.url_resolved, station.url);
    // A station we cannot hand the reader a playable link for is not worth a pin.
    if (!streamUrl) continue;

    features.push({
      id: station.stationuuid,
      kind: "radio",
      longitude: position.longitude,
      latitude: position.latitude,
      label: station.name.trim() || "Unnamed station",
      ...(station.homepage ? { sourceUrl: station.homepage } : {}),
      properties: {
        stationUuid: station.stationuuid,
        streamUrl,
        isHls: station.hls === 1,
        codec: station.codec ?? null,
        bitrateKbps: typeof station.bitrate === "number" ? station.bitrate : null,
        homepage: station.homepage ?? null,
        country: station.country ?? null,
        countryCode: station.countrycode ?? null,
        state: station.state ?? null,
        language: station.language ?? null,
        tags: station.tags ?? null,
        lastCheckOk: station.lastcheckok === 1,
        lastCheckedAt: station.lastcheckoktime_iso8601 ?? null,
        clickCount: typeof station.clickcount === "number" ? station.clickcount : null,
      },
    });
  }

  return { ok: true, features, observedAt: receivedAt };
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const RADIO_BROWSER_SLUG = "radio-browser";

/** Discover a mirror, caching the choice. Falls back to the documented example server. */
async function currentHost(signal: AbortSignal): Promise<string> {
  const cached = globalForServers.__cairnRadioServers__;
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.host;

  const { decodeJson, fetchUpstream } = await import("./http");
  const outcome = await fetchUpstream({
    slug: RADIO_BROWSER_SLUG,
    url: DISCOVERY_URL,
    signal,
    timeoutMs: 5_000,
  });
  if (!outcome.ok) return cached?.host ?? FALLBACK_HOST;

  const decoded = decodeJson(outcome.text);
  const host = decoded.ok ? pickServer(decoded.body) : FALLBACK_HOST;
  globalForServers.__cairnRadioServers__ = { host, at: Date.now() };
  return host;
}

export function clearServerCache(): void {
  delete globalForServers.__cairnRadioServers__;
}

export const radioBrowser: PollAdapter<RadioStationFeature> = {
  slug: RADIO_BROWSER_SLUG,
  name: "Radio Browser stations",
  kind: "radio",
  homepage: "https://www.radio-browser.info/",
  attribution: {
    /**
     * A public-domain dedication requires no credit. We render one anyway: a reader looking
     * at a pin needs to know which catalogue asserted that a station is there, and the
     * project is volunteer-run and deserves the traffic.
     */
    text: "Station data from the Radio Browser community catalogue",
    href: "https://www.radio-browser.info/",
    licence: "public domain dedication (project maintainer)",
  },
  /** Station metadata changes over days. Mirrors are volunteer-run; poll like a guest. */
  ttlSeconds: 3600,
  responseSchema: radioBrowserResponseSchema,
  normalise: normaliseRadioBrowser,

  async fetch(signal: AbortSignal): Promise<SourceResult<RadioStationFeature>> {
    const host = await currentHost(signal);
    const url =
      `https://${host}/json/stations/search` +
      `?has_geo_info=true&hidebroken=true&order=clickcount&reverse=true&limit=${STATION_LIMIT}`;

    return pollJson<RadioStationFeature>({
      slug: RADIO_BROWSER_SLUG,
      url,
      signal,
      timeoutMs: 15_000,
      maxBytes: 4 * 1024 * 1024,
      normalise: normaliseRadioBrowser,
    });
  },

  healthcheck(signal: AbortSignal) {
    return healthcheckByFetch(radioBrowser, signal);
  },
};

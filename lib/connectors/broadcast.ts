import type { Connector } from "@/db/schema";
import {
  broadcastFilterSchema,
  BROADCAST_ATTRIBUTION,
  filtersCacheKey,
  buildSearchParams,
  normaliseBroadcast,
  type BroadcastFilters,
  type BroadcastStation,
} from "@/lib/toolbench/broadcast";
import { UpstreamStatusError } from "./runtime";
import { decodeJson, upstreamGet } from "./toolbench";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/broadcast-finder`: Radio Browser station search by place, language and name.
 *
 * Terms (checked 2026-09-01): catalogue is public domain; that does not cover the audio,
 * which belongs to each broadcaster. No key. API asks for a descriptive User-Agent. Rate
 * limit unpublished and mirrors are volunteer-run, so quotas are small and searches cached.
 *
 * - We never fetch or relay stream audio; the browser connects to the broadcaster directly.
 * - We never send the `/json/url` click-tracking request, which would tell a third party
 *   which station each reader opened.
 */

/**
 * SSRF guard, duplicated from `lib/sources/radio-browser.ts` so this module doesn't depend on
 * the map adapter. `connectors.base_url` is operator-set, but is still pinned to this domain.
 */
const HOST_PATTERN = /^[a-z0-9-]+\.api\.radio-browser\.info$/;

export const BROADCAST_CONNECTOR_SLUG = "radio-browser";

export type BroadcastPayload = {
  readonly stations: readonly BroadcastStation[];
  /** What the reader actually searched for, echoed so the results can state their own scope. */
  readonly filters: BroadcastFilters;
};

export const broadcastDriver: ConnectorDriver<BroadcastFilters, BroadcastPayload> = {
  /** Shares the existing `radio-browser` registry row, so one upstream has one kill switch. */
  kind: "radio",
  slug: BROADCAST_CONNECTOR_SLUG,

  /** Bounds every value before it can reach a URL. Throws on anything outside the schema. */
  normalise: (raw) => broadcastFilterSchema.parse(raw),

  /**
   * Keyed on the query only, not the caller. Since the query is user-typed, `runConnector`
   * charges quota before the cache read so a hit can't be probed for free.
   */
  cacheKey: filtersCacheKey,

  async fetch(connector: Connector, params, signal) {
    const base = new URL(connector.baseUrl);
    if (base.protocol !== "https:" || !HOST_PATTERN.test(base.hostname)) {
      // Misconfigured registry row: make no request.
      throw new UpstreamStatusError(502);
    }

    const url = `https://${base.hostname}/json/stations/search?${buildSearchParams(params).toString()}`;

    // `upstreamGet` pins the host, caps bytes and sets the User-Agent. The endpoint doesn't
    // redirect, so any 3xx is an error.
    const response = await upstreamGet({
      url,
      pinnedHost: base.hostname,
      signal,
      accept: "application/json",
      maxBytes: 4 * 1024 * 1024,
      maxRedirects: 0,
    });

    const stations = normaliseBroadcast(decodeJson(response.text));
    if (!stations.ok) {
      // Shape change: report unavailable rather than "no stations found".
      throw new UpstreamStatusError(502);
    }

    return {
      data: { stations: stations.value, filters: params },
      upstreamStatus: response.status,
    };
  },
};

/**
 * Uses the existing `radio-browser` row from `lib/sources/connector-seeds.ts` (seeded draft
 * and disabled). Enabling it permits search traffic only; playback goes browser-to-broadcaster.
 */
export const BROADCAST_ATTRIBUTION_STRING = BROADCAST_ATTRIBUTION;

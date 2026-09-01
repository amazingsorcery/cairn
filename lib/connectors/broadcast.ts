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
 * `/toolbench/broadcast-finder` — the Radio Browser station catalogue, searched by place,
 * language and name. product-brief §3.3: an outbound request on a user's behalf lives here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS — reused wholesale from `docs/sources/radio-browser.md`, re-checked 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * The terms work belongs to whoever calls the API, so it applies here unchanged:
 *
 * Licence      Public domain dedication by the project maintainer: "I give all the rights I
 *              have at the accumulated data to the public domain." NOTE THE PRECISION — the
 *              maintainer dedicates the rights *they have*. The dedication covers the
 *              catalogue. It does not and cannot license the audio, which belongs to each
 *              broadcaster. That is why we hand out a link and never a relay.
 * Key          None. No registration, no account.
 * User-Agent   Asked for explicitly: "Send a speaking http agent string".
 * Rate limit   Not published. Mirrors are volunteer-run, so the ceiling below is small and
 *              identical searches share one cached upstream call.
 * Access ctrl  None circumvented. Documented public endpoint, no auth.
 *
 * TWO DELIBERATE OMISSIONS, carried over from the map adapter because they are the point:
 *
 * 1. **We never touch the audio.** The stream URL goes to the browser, which connects to the
 *    broadcaster directly. product-brief §2b: relaying audio turns a linking site into a
 *    rebroadcasting one, and the arithmetic is not close — fifty concurrent listeners at
 *    128 kbit/s is roughly 2.1 TB a month, about a thousand times this whole deployment's
 *    traffic. There is no code path here that fetches a stream URL and there must never be.
 *
 * 2. **We never send the `/json/url` click-tracking request.** The API asks callers to
 *    report every click so popular stations can be marked as such. For a media player that
 *    is a fair trade; here it would tell a third party which station each of our readers
 *    opened, which is precisely the interest-graph leak product-brief §3.2 constraint 4
 *    forbids. We take the data and decline the telemetry. This comment exists so the
 *    omission reads as a decision rather than an oversight.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ADR 0013: the audit row records that a search happened, never what was searched for.
 */

/**
 * The SSRF guard, copied deliberately rather than imported.
 *
 * `lib/sources/radio-browser.ts` has the same pattern for the same reason, and the
 * duplication is the point: this module must not depend on the map adapter's internals to
 * stay safe. The host that reaches `fetch` comes from `connectors.base_url` — an operator's
 * value in our own database, not a user's — and it is pinned to the project's own domain
 * anyway, so a bad row cannot redirect this server anywhere else.
 */
const HOST_PATTERN = /^[a-z0-9-]+\.api\.radio-browser\.info$/;

export const BROADCAST_CONNECTOR_SLUG = "radio-browser";

export type BroadcastPayload = {
  readonly stations: readonly BroadcastStation[];
  /** What the reader actually searched for, echoed so the results can state their own scope. */
  readonly filters: BroadcastFilters;
};

export const broadcastDriver: ConnectorDriver<BroadcastFilters, BroadcastPayload> = {
  /**
   * `radio` resolves to the existing `radio-browser` registry row — the same operator, the
   * same terms, the same kill-switch. One switch for one upstream is the property ADR 0024
   * merged the two registries to get; a second row for the same service would give an
   * operator two places to look during an incident.
   */
  kind: "radio",
  slug: BROADCAST_CONNECTOR_SLUG,

  /** Bounds every value before it can reach a URL. Throws on anything outside the schema. */
  normalise: (raw) => broadcastFilterSchema.parse(raw),

  /**
   * The query and nothing about who asked (ADR 0014 §4) — but the query is the name, country
   * or tag the READER typed, so a free read of the shared entry would answer "what did
   * somebody else search for?". QV-02: `runConnector` spends the caller's quota before it
   * consults the cache, for every driver, so a hit costs a unit and leaves a counter behind.
   */
  cacheKey: filtersCacheKey,

  async fetch(connector: Connector, params, signal) {
    const base = new URL(connector.baseUrl);
    if (base.protocol !== "https:" || !HOST_PATTERN.test(base.hostname)) {
      // A registry row pointing somewhere else is a misconfiguration, and the right
      // response to it is to make no request at all rather than to make one.
      throw new UpstreamStatusError(502);
    }

    const url = `https://${base.hostname}/json/stations/search?${buildSearchParams(params).toString()}`;

    /**
     * `upstreamGet` rather than a bare `fetch`: it pins the host on every hop, refuses a
     * redirect off it, caps the bytes we will read, and sends the one User-Agent built from
     * `config/brand.ts`. A community-run mirror answering with a 302 somewhere else is
     * exactly the shape an SSRF takes when the "trusted" upstream is not.
     *
     * `maxRedirects: 0` — the documented endpoint does not redirect, so a 3xx here is an
     * error rather than something to follow.
     */
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
      // A shape change must degrade honestly rather than render as "no stations found",
      // which a reader would take as a fact about the world.
      throw new UpstreamStatusError(502);
    }

    return {
      data: { stations: stations.value, filters: params },
      upstreamStatus: response.status,
    };
  },
};

/**
 * The registry row this driver uses is the EXISTING `radio-browser` row, seeded by
 * `db/seed.ts` from `lib/sources/connector-seeds.ts` — operator "Radio Browser (community
 * maintained)", `base_url` `https://all.api.radio-browser.info`, quotas 5/user and 10/global
 * per minute, seeded `draft` and disabled.
 *
 * No new row is added here on purpose. Two rows for one upstream would mean two kill
 * switches and two quota envelopes against one volunteer service's fair use.
 *
 * The one thing an operator must know before enabling it for this tool, which is not true of
 * the map layer: **the audio does not come through us**, so enabling this connector permits
 * search traffic only. Playback is a direct connection from the reader's browser to the
 * broadcaster and no switch here affects it.
 */
export const BROADCAST_ATTRIBUTION_STRING = BROADCAST_ATTRIBUTION;

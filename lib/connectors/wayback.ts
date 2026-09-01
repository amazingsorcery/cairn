import { z } from "zod";

import type { Connector } from "@/db/schema";
import { connectorHost, normaliseLookupUrl } from "@/lib/toolbench/net-target";
import {
  buildTimeline,
  cdxResponseSchema,
  decodeCdx,
  htmlToText,
  parseWaybackTimestamp,
  snapshotUrl,
  WAYBACK_HOST,
  type Timeline,
} from "@/lib/toolbench/wayback";

import { UpstreamStatusError } from "./runtime";
import { decodeJson, upstreamGet } from "./toolbench";
import type { ConnectorDriver } from "./types";

/**
 * `/toolbench/wayback-explorer` — the capture timeline for a URL, and the text of two captures.
 *
 * Two drivers, one registry row. They share `slug`, so they share the kill-switch, the
 * quota envelope, the attribution and the audit trail — which is right, because they are one
 * agreement with one operator. They are separate `ConnectorDriver`s only because they take
 * different parameters and return different payloads, and a single driver with a union
 * parameter would have made both halves harder to read for no gain. Their cache keys are
 * prefixed so the shared `slug:key` namespace cannot collide.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CONFIRMED, AND HOW — 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **Endpoints.** `https://web.archive.org/cdx/search/cdx` for the index — documented in
 *    the Internet Archive's own `wayback-cdx-server` README — and
 *    `https://web.archive.org/web/<timestamp>id_/<url>` for one capture. The `id_` suffix
 *    asks for the **original bytes** rather than the archive's rewritten copy, which is what
 *    makes a diff about the page rather than about the archive's toolbar. Both exercised live.
 *
 * 2. **It is slow, unpredictably, and that is normal.** The *same* CDX query for `ripe.net`
 *    returned in 3.4 s on one attempt and 38.3 s on the next, byte-identical both times — so
 *    the latency is the archive's load, not our payload, and no amount of tuning the query
 *    removes it. Six other identical queries ranged from 0.4 s to 17 s. The tool sends
 *    `limit`, `fl` and `collapse=digest` to ask for as little work as possible, the timeout
 *    is 40 s, and a timeout is reported as "the archive did not answer in time" rather than
 *    as "no captures", because those are opposite conclusions and only one is a finding.
 *
 * 3. **No robots.txt.** `https://web.archive.org/robots.txt` returns 404, so there is no
 *    crawl directive either way. We are not crawling: one documented index query, and at most
 *    two capture fetches, per user action.
 *
 * 4. **Terms.** The Internet Archive's Terms of Use state that "access to the Archive's
 *    Collections is provided at no cost to you and is granted for scholarship and research
 *    purposes only", ask users not to "interfere with the work of other users or Archive
 *    personnel, servers, or resources", and request that the Archive be listed as a resource
 *    in the bibliography of any resulting publication. All three are consistent with this
 *    tool: the audience is research, the rate is bounded and cached, and the attribution is
 *    rendered next to the results rather than in a footer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SSRF — THE ONE PLACE A USER VALUE TOUCHES A PATH
 * ─────────────────────────────────────────────────────────────────────────────
 * The capture fetch is the only request in the Toolbench whose *path* contains a URL the
 * reader supplied. Four things stand between that and a server-side request forgery:
 *
 *   - the host is the constant `web.archive.org`, never anything derived from input;
 *   - the timestamp must match `\d{14}` and round-trip through a real calendar date;
 *   - the original URL is re-validated by `normaliseLookupUrl`, which rejects a non-web
 *     scheme, credentials, an explicit port and every private, loopback, link-local,
 *     unique-local, documentation and metadata address, in both IP versions;
 *   - `upstreamGet` re-checks the pinned host before the request **and on every redirect
 *     hop**, with `redirect: "manual"`. The archive genuinely redirects between capture
 *     timestamps, so redirects cannot simply be forbidden — they have to be walked with the
 *     pin re-applied, which is what happens.
 *
 * And the response is never rendered as HTML. It is reduced to text and diffed;
 * `dangerouslySetInnerHTML` is lint-banned in this repository.
 */

export const WAYBACK_CONNECTOR_SLUG = "internet-archive-wayback";

/* ------------------------------------------------------------------ *
 * The timeline
 * ------------------------------------------------------------------ */

/**
 * Captures we will read for one URL.
 *
 * `collapse=digest` is sent as well, which asks the archive to drop consecutive captures with
 * an identical digest — so this is 4,000 *distinct versions*, not 4,000 crawls, and for all
 * but a handful of URLs it is the whole history.
 */
const MAX_CAPTURES = 4000;

export const waybackTimelineParamsSchema = z.object({ url: z.string() });
export type WaybackTimelineParams = { url: string };

export const waybackTimelineDriver: ConnectorDriver<WaybackTimelineParams, Timeline> = {
  kind: "infrastructure",
  slug: WAYBACK_CONNECTOR_SLUG,

  normalise(raw: unknown): WaybackTimelineParams {
    const parsed = waybackTimelineParamsSchema.parse(raw);
    const url = normaliseLookupUrl(parsed.url);
    if (!url.ok) throw new Error("invalid url");
    return { url: url.value.href };
  },

  /** The cache key is the URL the reader typed — a private query. See QV-02. */
  cacheKey: (params) => `timeline|${params.url}`,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams({
      url: params.url,
      output: "json",
      // Ask for exactly the columns we read. Fewer columns is less work for a service that
      // is visibly under load, and `decodeCdx` maps by header name so the set can change.
      fl: "timestamp,original,mimetype,statuscode,digest,length",
      // Drop consecutive captures whose content digest is unchanged. This is the single
      // biggest reduction available and it is exactly the question the tool asks.
      collapse: "digest",
      limit: String(MAX_CAPTURES + 1),
    });

    const response = await upstreamGet({
      url: `${base}/cdx/search/cdx?${query.toString()}`,
      pinnedHost: connectorHost(connector.baseUrl),
      signal,
      maxBytes: 8 * 1024 * 1024,
    });

    // A URL with no captures answers 200 with an empty body, not an empty JSON array.
    if (response.text.trim() === "") {
      return { data: buildTimeline(params.url, []), upstreamStatus: response.status };
    }

    const parsed = cdxResponseSchema.safeParse(decodeJson(response.text));
    if (!parsed.success) throw new UpstreamStatusError(502);

    const snapshots = decodeCdx(parsed.data);
    return {
      data: buildTimeline(params.url, snapshots.slice(0, MAX_CAPTURES), {
        truncated: snapshots.length > MAX_CAPTURES,
      }),
      upstreamStatus: response.status,
    };
  },
};

/* ------------------------------------------------------------------ *
 * Two captures, as text
 * ------------------------------------------------------------------ */

export const waybackCapturesParamsSchema = z.object({
  url: z.string(),
  before: z.string(),
  after: z.string(),
});

export type WaybackCapturesParams = { url: string; before: string; after: string };

export interface CaptureText {
  readonly timestamp: string;
  readonly capturedAt: string;
  readonly text: string;
  /** Bytes of the original capture, before text extraction. */
  readonly sourceBytes: number;
  readonly contentType: string | null;
}

export interface CapturePair {
  readonly url: string;
  readonly before: CaptureText;
  readonly after: CaptureText;
}

/** A capture is a whole web page. 4 MB is far past any page worth diffing as text. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export const waybackCapturesDriver: ConnectorDriver<WaybackCapturesParams, CapturePair> = {
  kind: "infrastructure",
  slug: WAYBACK_CONNECTOR_SLUG,

  normalise(raw: unknown): WaybackCapturesParams {
    const parsed = waybackCapturesParamsSchema.parse(raw);
    const url = normaliseLookupUrl(parsed.url);
    if (!url.ok) throw new Error("invalid url");
    if (parseWaybackTimestamp(parsed.before) === null || parseWaybackTimestamp(parsed.after) === null) {
      throw new Error("invalid timestamp");
    }
    return { url: url.value.href, before: parsed.before, after: parsed.after };
  },

  /**
   * The URL and the two capture timestamps the reader chose. The one-hour TTL makes this the
   * longest-lived entry of the six, and therefore the most useful oracle if a read of it were
   * ever free again. Private query.
   */
  cacheKey: (params) => `captures|${params.url}|${params.before}|${params.after}`,

  async fetch(_connector: Connector, params, signal) {
    // The host is the module constant, NOT `connector.baseUrl`. The capture path form is
    // specific to web.archive.org, so pointing the row elsewhere would produce a request
    // that could not be correct — better to hold the pin here where it is checkable.
    const load = async (timestamp: string): Promise<CaptureText> => {
      const built = snapshotUrl(timestamp, params.url);
      if (!built.ok) throw new UpstreamStatusError(400);

      const response = await upstreamGet({
        url: built.value,
        pinnedHost: WAYBACK_HOST,
        signal,
        accept: "text/html,text/plain",
        /*
         * The original bytes, uncompressed. This tool diffs archived text and gains nothing
         * from transfer compression it then has to bound: `fetch` gunzips transparently, so
         * a declared `Content-Length` on a gzipped capture describes the compressed size and
         * says nothing about what lands in memory. QV-03. The streaming cap below is the
         * control; this makes the declared length mean what it appears to mean.
         */
        acceptEncoding: "identity",
        maxBytes: MAX_CAPTURE_BYTES,
        // The archive redirects to the nearest capture when the exact timestamp is not the
        // one it holds. Each hop is re-checked against the pin.
        maxRedirects: 3,
      });

      const contentType = response.contentType?.split(";")[0]?.trim().toLowerCase() ?? null;
      // A PDF or an image is not something this tool can diff, and saying so is better than
      // rendering the mangled text of a binary.
      if (contentType !== null && !contentType.startsWith("text/")) {
        throw new UpstreamStatusError(415);
      }

      const text =
        contentType === "text/plain" ? response.text.trim() : htmlToText(response.text);

      return {
        timestamp,
        capturedAt: parseWaybackTimestamp(timestamp)?.toISOString() ?? "",
        text,
        sourceBytes: response.text.length,
        contentType,
      };
    };

    // Sequential rather than parallel: the Internet Archive's terms ask users not to
    // interfere with its servers, and two capture fetches is a heavier request than an
    // index query. One at a time is the polite reading, and the tool is not latency-critical.
    const before = await load(params.before);
    const after = await load(params.after);

    return { data: { url: params.url, before, after }, upstreamStatus: 200 };
  },
};

export const WAYBACK_CONNECTOR_SEED = {
  slug: WAYBACK_CONNECTOR_SLUG,
  name: "Internet Archive Wayback Machine",
  kind: "infrastructure" as const,
  operatorName: "Internet Archive",
  homepageUrl: "https://web.archive.org/",
  termsUrl: "https://archive.org/about/terms.php",
  attribution: "Capture history and archived pages from the Internet Archive's Wayback Machine.",
  attributionRequired: true,
  legalBasis:
    "The Internet Archive's Terms of Use (read 2026-09-01 via an archived capture, because " +
    "the live page renders client-side) state that 'access to the Archive's Collections is " +
    "provided at no cost to you and is granted for scholarship and research purposes only', " +
    "ask users not to 'interfere with the work of other users or Archive personnel, servers, " +
    "or resources', and request that the Archive be listed as a resource in the bibliography " +
    "of any publication resulting from its use. All three are met: the audience and purpose " +
    "are research, the rate is bounded and cached, and attribution is rendered next to the " +
    "results rather than in a footer. The CDX server interface is documented by the Archive " +
    "itself in the wayback-cdx-server README. No robots.txt is published for web.archive.org " +
    "(404 on 2026-09-01), so no crawl directive is being circumvented, and we crawl nothing. " +
    "RATE: no numeric limit is published. Measured 2026-09-01, six identical CDX queries took " +
    "between 0.4s and 17s, and the SAME query returned in 3.4s then 38.3s on consecutive " +
    "attempts with a byte-identical payload - the latency is their load, not our payload, so " +
    "the columns here are OURS and are set low. Every index query sends limit, fl and " +
    "collapse=digest to reduce the work asked of it. A diff makes two capture fetches, issued " +
    "SEQUENTIALLY rather than in parallel, which is the polite reading of the " +
    "do-not-interfere clause. Nothing retries. " +
    "NO ARCHIVED CONTENT IS RE-HOSTED OR RENDERED: a capture is reduced to plain text " +
    "server-side for the diff and the reader is linked to the Archive's own page for the " +
    "capture itself. NOT A LEGAL OPINION - see docs/content/legal-review.md.",
  baseUrl: "https://web.archive.org",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 4,
  globalCeiling: 8,
  windowSeconds: 60,
  /**
   * 40s, which is uncomfortably long for a request that holds a server connection open and
   * is nevertheless the measured reality: the identical CDX query took 3.4s and then 38.3s
   * on consecutive attempts. A shorter timeout would not make the archive faster, it would
   * turn a slow success into a failure the reader cannot distinguish from an empty result.
   */
  timeoutMs: 40_000,
  /** An hour. Capture history changes slowly and an archived capture never changes at all. */
  cacheTtlSeconds: 3600,
  staleWhileRevalidateSeconds: 21_600,
  enabled: false,
  status: "draft" as const,
  notes:
    "CDX index and capture fetch both verified live 2026-09-01. Two drivers share this row: " +
    "waybackTimelineDriver (index) and waybackCapturesDriver (two captures for a diff), so " +
    "the kill-switch and quota cover both. See docs/sources/internet-archive-wayback.md.",
};

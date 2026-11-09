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
 * Two drivers share one registry row (kill switch, quota, attribution, audit). Cache keys are
 * prefixed so they can't collide.
 *
 * Notes (verified 2026-09-01):
 * - Index: `/cdx/search/cdx` (wayback-cdx-server README). Capture: `/web/<ts>id_/<url>`;
 *   `id_` returns the original bytes, not the archive's rewritten page.
 * - Latency varies widely (the same query took 3.4s then 38.3s), so we send `limit`, `fl`
 *   and `collapse=digest`, allow 40s, and report a timeout as such, not as "no captures".
 * - robots.txt is 404.
 * - Terms: research use, don't interfere with servers, credit the Archive. Rate is bounded
 *   and cached; attribution is shown next to results.
 *
 * SSRF: the capture path contains a user-supplied URL. Guards: constant host; timestamp must
 * be a valid `\d{14}` date; URL re-validated by `normaliseLookupUrl` (no private/loopback/
 * metadata addresses, credentials or ports); host re-pinned on every redirect hop.
 * The response is reduced to text, never rendered as HTML.
 */

export const WAYBACK_CONNECTOR_SLUG = "internet-archive-wayback";

/* ------------------------------------------------------------------ *
 * The timeline
 * ------------------------------------------------------------------ */

/** Max captures per URL. With `collapse=digest` these are distinct versions. */
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

  /** The URL the reader typed is a private query; quota is charged before cache reads. */
  cacheKey: (params) => `timeline|${params.url}`,

  async fetch(connector: Connector, params, signal) {
    const base = connector.baseUrl.replace(/\/+$/, "");
    const query = new URLSearchParams({
      url: params.url,
      output: "json",
      // Only the columns we read; `decodeCdx` maps by header name.
      fl: "timestamp,original,mimetype,statuscode,digest,length",
      // Drop consecutive captures with unchanged content.
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

  /** URL plus the two chosen timestamps: a private query with a long TTL. */
  cacheKey: (params) => `captures|${params.url}|${params.before}|${params.after}`,

  async fetch(_connector: Connector, params, signal) {
    // Host is the module constant, not `connector.baseUrl`: the path form is specific to
    // web.archive.org.
    const load = async (timestamp: string): Promise<CaptureText> => {
      const built = snapshotUrl(timestamp, params.url);
      if (!built.ok) throw new UpstreamStatusError(400);

      const response = await upstreamGet({
        url: built.value,
        pinnedHost: WAYBACK_HOST,
        signal,
        accept: "text/html,text/plain",
        // Uncompressed, so `Content-Length` reflects the decoded size.
        acceptEncoding: "identity",
        maxBytes: MAX_CAPTURE_BYTES,
        // The archive redirects to the nearest capture; each hop is re-pinned.
        maxRedirects: 3,
      });

      const contentType = response.contentType?.split(";")[0]?.trim().toLowerCase() ?? null;
      // Non-text captures can't be diffed.
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

    // Sequential, to go easy on the archive's servers.
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
    "capture itself. NOT A LEGAL OPINION.",
  baseUrl: "https://web.archive.org",
  requiresApiKey: false,
  apiKeyEnvVar: null,
  perUserQuota: 4,
  globalCeiling: 8,
  windowSeconds: 60,
  /** Long, but measured: the same CDX query took 3.4s then 38.3s. */
  timeoutMs: 40_000,
  /** An hour. Capture history changes slowly and an archived capture never changes at all. */
  cacheTtlSeconds: 3600,
  staleWhileRevalidateSeconds: 21_600,
  enabled: false,
  status: "draft" as const,
  notes:
    "CDX index and capture fetch both verified live 2026-09-01. Two drivers share this row: " +
    "waybackTimelineDriver (index) and waybackCapturesDriver (two captures for a diff), so " +
    "the kill-switch and quota cover both.",
};

import brand from "@/config/brand";
import { logger } from "@/lib/logger";
import { readCappedText } from "@/lib/net/capped-body";
import { countOutboundRequest } from "@/lib/net/outbound-tally";
import { isPinnedHost } from "@/lib/toolbench/net-target";

import { parseRetryAfter, UpstreamStatusError } from "./runtime";

/**
 * The only place in `lib/connectors/` that opens a socket
 * (`tests/security/outbound-primitive.test.ts` fails if another file calls `fetch`).
 *
 *  1. Host pinned before the request and on every redirect hop (`redirect: "manual"`), so an
 *     open redirect upstream can't become an SSRF.
 *  2. Body capped while streaming, so a missing or misleading `Content-Length` can't exhaust
 *     memory.
 *  3. Every hop counted for the audit row.
 *
 * Never logs the URL, query, domain, IP or response body.
 */

/**
 * Identifies us (not the user) so operators can contact or throttle us. Built from
 * `config/brand.ts`; `SOURCE_CONTACT_EMAIL` overrides the contact address.
 */
export function toolbenchUserAgent(
  env: (name: string) => string | undefined = (name) => process.env[name],
): string {
  const contact = env("SOURCE_CONTACT_EMAIL")?.trim() || brand.email.support;
  return `${brand.nameLower}-toolbench/1.0 (+${contact})`;
}

/** Default body cap. Generous because crt.sh can return several MB for a large domain. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface UpstreamRequestOptions {
  /** Absolute URL. MUST be built from `connector.baseUrl`, never from user input. */
  readonly url: string;
  /** The host the URL is required to be on. Checked before the request and on each redirect. */
  readonly pinnedHost: string;
  readonly signal: AbortSignal;
  /** `GET` by default. `POST` is for Overpass, keeping the query out of access logs. */
  readonly method?: "GET" | "POST";
  /** Encoded body with its `Content-Type`, for `POST`. Never resent across a redirect. */
  readonly body?: { readonly contentType: string; readonly text: string };
  readonly accept?: string;
  /** Override the User-Agent (flights keeps the `sourceUserAgent()` string adsb.lol knows). */
  readonly userAgent?: string;
  /**
   * Sent as `Accept-Encoding` if set. Wayback passes `identity` so `Content-Length` matches
   * decoded size and compressed bombs aren't possible.
   */
  readonly acceptEncoding?: string;
  readonly maxBytes?: number;
  /**
   * Redirect hops to follow, each re-checked against `pinnedHost`. 0 = any 3xx is an error.
   * Wayback needs a few (it redirects between capture timestamps).
   */
  readonly maxRedirects?: number;
}

/** A GET, which is what every driver but Overpass needs. */
export type UpstreamGetOptions = Omit<UpstreamRequestOptions, "method" | "body">;

export type UpstreamResponse = {
  text: string;
  status: number;
  contentType: string | null;
};

/**
 * One request, host-pinned, byte-capped, with manual redirect handling.
 *
 * Throws `UpstreamStatusError` on non-2xx (so `runtime.ts` can record it and open a cooldown
 * on 429). Never returns an error body, which may echo the reader's query.
 */
export async function upstreamRequest(
  options: UpstreamRequestOptions,
): Promise<UpstreamResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 0;
  const method = options.method ?? "GET";

  let url = options.url;
  for (let hop = 0; ; hop += 1) {
    if (!isPinnedHost(url, options.pinnedHost)) {
      // Edited registry row or an off-host redirect.
      logger.error(
        { scope: "connector.upstream", pinnedHost: options.pinnedHost, hop },
        "Refusing a request that is not on the pinned host",
      );
      throw new UpstreamStatusError(502);
    }

    // Once per hop: each redirect followed is a request made.
    countOutboundRequest();
    const response = await fetch(url, {
      method,
      signal: options.signal,
      redirect: "manual",
      // Our own cache owns freshness; avoid a second cache clock.
      cache: "no-store",
      headers: {
        accept: options.accept ?? "application/json",
        "user-agent": options.userAgent ?? toolbenchUserAgent(),
        ...(options.acceptEncoding === undefined
          ? {}
          : { "accept-encoding": options.acceptEncoding }),
        ...(options.body === undefined ? {} : { "content-type": options.body.contentType }),
      },
      ...(options.body === undefined ? {} : { body: options.body.text }),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // A redirect on a request with a body is always an error: following would resend the
      // query elsewhere or silently drop it.
      if (location === null || hop >= maxRedirects || options.body !== undefined) {
        throw new UpstreamStatusError(
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      // Resolve relative Location against the current URL; the pin is re-checked next loop.
      url = new URL(location, url).toString();
      await response.body?.cancel();
      continue;
    }

    if (!response.ok) {
      // Read Retry-After on any non-2xx; a 503 may carry one too.
      throw new UpstreamStatusError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    // Cap applied to the stream: reading stops once the running total passes `maxBytes`.
    const capped = await readCappedText(response, maxBytes);
    if (!capped.ok) {
      logger.warn(
        { scope: "connector.upstream", reason: capped.reason, bytes: capped.bytes, maxBytes },
        "Upstream payload exceeded the cap",
      );
      throw new UpstreamStatusError(502);
    }

    return {
      text: capped.text,
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
  }
}

/** `upstreamRequest` with the method it has for every driver but Overpass. */
export function upstreamGet(options: UpstreamGetOptions): Promise<UpstreamResponse> {
  return upstreamRequest({ ...options, method: "GET" });
}

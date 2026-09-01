import brand from "@/config/brand";
import { logger } from "@/lib/logger";
import { readCappedText } from "@/lib/net/capped-body";
import { countOutboundRequest } from "@/lib/net/outbound-tally";
import { isPinnedHost } from "@/lib/toolbench/net-target";

import { parseRetryAfter, UpstreamStatusError } from "./runtime";

/**
 * THE ONE PLACE IN `lib/connectors/` THAT OPENS A SOCKET.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE — QA finding QV-03, reopened
 * ─────────────────────────────────────────────────────────────────────────────
 * `upstreamGet` lived in `lib/connectors/toolbench.ts`, and four of the six drivers used it.
 * `overpass.ts` and `flights.ts` called `globalThis.fetch` themselves, so neither the byte
 * cap nor the redirect pin nor the outbound tally applied to them at all. QA measured 513 MiB
 * pulled through the Overpass path — whose request body is a reader-supplied query — against
 * the 5 MiB the capped path stops at, and asserted that both sent the runtime's default
 * `redirect: "follow"` with no host re-pin, which is QV-18 arriving inside the layer whose
 * own comment rejects it.
 *
 * The helper was correct. It was simply not the only route to the socket. So it now lives in
 * a file whose entire purpose is to be that route, and `tests/security/outbound-primitive.test.ts`
 * reads the source of every other file in this directory and fails the build if one of them
 * calls `fetch`. A helper nobody is forced to use is a suggestion.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE CONTROLS, AND WHY EACH IS HERE RATHER THAN IN A DRIVER
 * ─────────────────────────────────────────────────────────────────────────────
 *  1. **The host is pinned**, before the request and again on every redirect hop.
 *     `redirect: "manual"`, deliberately: `follow` would walk a 302 anywhere the upstream
 *     pointed, and "the upstream is trustworthy" is exactly the assumption an SSRF exploits —
 *     an open redirect on an otherwise honest service is enough.
 *  2. **The body is capped while it is arriving.** `readCappedText` reads through the
 *     `ReadableStream` and cancels the moment the running total passes the ceiling, so a
 *     response with no `Content-Length`, or one whose declared length describes gzipped
 *     bytes, still cannot spend more than the cap plus one chunk of this process's memory.
 *     The deployment target is one VPS running the app, the worker and Postgres together.
 *  3. **Every hop is counted** (`countOutboundRequest`), because the audit row records
 *     outbound VOLUME and a redirect we followed is a request we made (QV-09). Counting here
 *     rather than in the driver is what stops the count drifting when a driver adds a call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEVER LOGGED
 * ─────────────────────────────────────────────────────────────────────────────
 * The URL, the query, the domain, the IP, the response body. ADR 0013: the record says THAT
 * a call happened, never WHAT was asked for. A journalist's lookups must not be
 * reconstructable from our own records, and the only reliable way to guarantee that is for
 * the record never to exist.
 */

/**
 * Identify ourselves. Courtesy and self-interest: an operator who needs to rate-limit or
 * contact us can, instead of blocking an anonymous pattern. It says nothing whatsoever
 * about the person who typed the query.
 *
 * Brand strings come from `config/brand.ts` (product-brief §7). `SOURCE_CONTACT_EMAIL`
 * overrides the placeholder address without a code change, which matters more than usual
 * here: an upstream that cannot reach us blocks us silently.
 */
export function toolbenchUserAgent(
  env: (name: string) => string | undefined = (name) => process.env[name],
): string {
  const contact = env("SOURCE_CONTACT_EMAIL")?.trim() || brand.email.support;
  return `${brand.nameLower}-toolbench/1.0 (+${contact})`;
}

/**
 * Bytes we will read from an upstream before giving up.
 *
 * crt.sh returned 1.35 MB for one mid-sized domain during verification and will return
 * considerably more for a large one, so the cap is generous — but it is a cap, because a
 * response with no ceiling is a way to exhaust a small VPS's memory from a text field.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface UpstreamRequestOptions {
  /** Absolute URL. MUST be built from `connector.baseUrl`, never from user input. */
  readonly url: string;
  /** The host the URL is required to be on. Checked before the request and on each redirect. */
  readonly pinnedHost: string;
  readonly signal: AbortSignal;
  /**
   * `GET` unless stated. `POST` exists for one driver: Overpass takes its query in a form
   * body rather than a query string, precisely so the bounding box a reader is investigating
   * does not end up in the upstream's access log.
   */
  readonly method?: "GET" | "POST";
  /**
   * The request body, already encoded, with its `Content-Type`. Only meaningful for `POST`.
   * A body is NOT resent across a redirect: a 3xx on a POST is treated as an error, because
   * re-POSTing a reader's query to a location the upstream chose is the SSRF case with the
   * payload attached.
   */
  readonly body?: { readonly contentType: string; readonly text: string };
  readonly accept?: string;
  /**
   * The `User-Agent`, when this connector already identifies itself as something other than
   * the Toolbench. `flights.ts` passes `sourceUserAgent()`: adsb.lol has seen that string
   * since 2026-08-31 and an operator who has allow-listed or throttled it should not have it
   * change under them because we moved a function. Both strings are built from
   * `config/brand.ts`, so the rename contract holds either way (product-brief §7).
   */
  readonly userAgent?: string;
  /**
   * Sent verbatim as `Accept-Encoding`. Omitted entirely when absent, which leaves the
   * runtime's own default in place.
   *
   * The Wayback capture fetch passes `identity`. It wants the archived bytes, and transfer
   * compression on that path buys nothing while costing two things: `fetch` gunzips
   * transparently, so a `Content-Length` describes the compressed size and cannot bound the
   * decoded one, and a compressed body is a decompression bomb's delivery mechanism. The
   * streaming cap in `readCappedText` holds either way; this removes the ambiguity.
   */
  readonly acceptEncoding?: string;
  readonly maxBytes?: number;
  /**
   * Redirect hops to follow, each re-checked against `pinnedHost`. Zero means "a 3xx is an
   * error". The Wayback snapshot fetch needs a small number because the archive genuinely
   * redirects between capture timestamps.
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
 * Throws `UpstreamStatusError` on a non-2xx so `runtime.ts` can record the real status and
 * open a cooldown on a 429. Never returns an upstream error body to the caller: it is
 * third-party text of unknown shape which on some APIs echoes the request back, and this
 * request contains the reader's query.
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
      // Not an upstream fault. Either a registry row was edited to point somewhere else, or
      // the upstream tried to send us off-host. Neither is a request we will make.
      logger.error(
        { scope: "connector.upstream", pinnedHost: options.pinnedHost, hop },
        "Refusing a request that is not on the pinned host",
      );
      throw new UpstreamStatusError(502);
    }

    /*
     * Counted here, at the request, and once per hop. QV-09: the audit row records outbound
     * VOLUME, and a redirect we followed is a request we made. Declaring the number in the
     * driver instead would be right until somebody added a call — which is how the finding
     * arose in the first place.
     */
    countOutboundRequest();
    const response = await fetch(url, {
      method,
      signal: options.signal,
      redirect: "manual",
      // The freshness contract is ours (ADR 0014). A second cache with its own clock is the
      // two-clocks-disagreeing failure that makes an age display lie.
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
      /*
       * A redirect on a request that carried a body is an error, whatever `maxRedirects`
       * says. Following it would either resend the reader's query to a location the upstream
       * chose, or silently turn their POST into a GET with the query dropped. Both are worse
       * than a refusal the surface can explain.
       */
      if (location === null || hop >= maxRedirects || options.body !== undefined) {
        throw new UpstreamStatusError(
          response.status,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      // Resolved against the CURRENT url, so a relative Location behaves as a browser would.
      // The loop re-checks the pin at the top, which is the point.
      url = new URL(location, url).toString();
      // The body of a redirect is never read, so it is cancelled rather than buffered.
      await response.body?.cancel();
      continue;
    }

    if (!response.ok) {
      // `Retry-After` is read on every non-2xx, not only on 429: a 503 may carry one, and a
      // header we were given always beats a constant we chose.
      throw new UpstreamStatusError(
        response.status,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }

    /*
     * The cap is applied to the STREAM, not to a string that is already resident (QV-03).
     * `readCappedText` checks the declared length as a cheap early exit and then reads chunk
     * by chunk, cancelling the moment the running total passes the cap — so an upstream that
     * sends no `Content-Length`, or one whose declared length describes gzipped bytes, still
     * cannot spend more than the cap plus one chunk of this process's memory.
     */
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

/**
 * The host a registry row points at, for use as the pin.
 *
 * A driver passes `connector.baseUrl` and gets back the host it is allowed to talk to, so a
 * redirect cannot walk off the operator an admin actually configured. It does NOT make the
 * registry row trustworthy on its own: `overpass.ts` and `flights.ts` additionally compare it
 * against a module constant, because resolving the wrong row once already sent an Overpass
 * query to a DNS resolver's base URL.
 */
export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).hostname;
}

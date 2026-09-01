import brand from "@/config/brand";
import { logger } from "@/lib/logger";
import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";
import { isPinnedHost } from "@/lib/toolbench/net-target";

import { parseRetryAfter, UpstreamStatusError } from "./runtime";
import type { ConnectorEnvelope } from "./types";

/**
 * The shared HTTP path and envelope mapping for the four Toolbench network connectors.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THERE IS NO LONGER A `runToolConnector` WRAPPER, AND THAT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * This module used to export one, because `runConnector` resolved its registry row through
 * `getLiveConnector(driver.kind)` — the first enabled row of that kind — and all of these are
 * `kind = 'infrastructure'`. Resolving by kind would have served one source's row to another
 * source's driver, with the wrong attribution, the wrong quota and the wrong legal basis. The
 * wrapper resolved by slug instead and re-applied the four live checks that passing
 * `options.connector` bypasses.
 *
 * `runConnector` now resolves by `driver.slug` itself, so the wrapper was a second copy of
 * `isLive` maintained in a third place and has been deleted. Call `runConnector` directly.
 *
 * What remains here is the part that is genuinely specific to these four:
 *
 *   `upstreamGet`      one host-pinned GET with a byte cap and manual redirect handling
 *   `toLookupOutcome`  connector envelope -> the shape a Client Component renders
 *
 * `toolbenchActor` was here and has moved to `./actor`. It called `auth()`, which put the
 * whole of next-auth on the import path of every driver — and therefore of
 * `TOOLBENCH_CONNECTOR_SEEDS`, and therefore of `db/seed.ts`, whose test then could not load
 * at all. Seeds are data and must be readable with no request in scope.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEVER LOGGED
 * ─────────────────────────────────────────────────────────────────────────────
 * The domain, the IP, the URL. ADR 0013: the audit log records *that* a call happened, never
 * *what was asked for*. `connector_requests` has no column that could hold it, and nothing in
 * this file passes a query value to `logger`. A journalist's lookups must not be
 * reconstructable from our own records, and the only reliable way to guarantee that is for
 * the record never to exist.
 */

/** The `kind` all four Toolbench sources are registered under. See `db/schema.ts`. */
export const TOOLBENCH_CONNECTOR_KIND = "infrastructure" as const;

/* ------------------------------------------------------------------ *
 * The one outbound HTTP path for these four drivers
 * ------------------------------------------------------------------ */

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

export interface UpstreamGetOptions {
  /** Absolute URL. MUST be built from `connector.baseUrl`, never from user input. */
  readonly url: string;
  /** The host the URL is required to be on. Checked before the request and on each redirect. */
  readonly pinnedHost: string;
  readonly signal: AbortSignal;
  readonly accept?: string;
  readonly maxBytes?: number;
  /**
   * Redirect hops to follow, each re-checked against `pinnedHost`. Zero means "a 3xx is an
   * error". The Wayback snapshot fetch needs a small number because the archive genuinely
   * redirects between capture timestamps.
   */
  readonly maxRedirects?: number;
}

/**
 * One GET, host-pinned, with a byte cap.
 *
 * `redirect: "manual"`, deliberately. `follow` would walk a 302 anywhere the upstream
 * pointed, and "the upstream is trustworthy" is exactly the assumption an SSRF exploits —
 * an open redirect on an otherwise honest service is enough. Each hop's `Location` is
 * resolved against the current URL and re-checked against the pinned host before it is
 * followed, so a redirect off-host is a refusal rather than a request.
 *
 * Throws `UpstreamStatusError` on a non-2xx so `runtime.ts` can record the real status and
 * open a cooldown on a 429. Never returns an upstream error body to the caller: it is
 * third-party text of unknown shape which on some APIs echoes the request back, and this
 * request contains the reader's query.
 */
export async function upstreamGet(
  options: UpstreamGetOptions,
): Promise<{ text: string; status: number; contentType: string | null }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 0;

  let url = options.url;
  for (let hop = 0; ; hop += 1) {
    if (!isPinnedHost(url, options.pinnedHost)) {
      // Not an upstream fault. Either a registry row was edited to point somewhere else, or
      // the upstream tried to send us off-host. Neither is a request we will make.
      logger.error(
        { scope: "toolbench.connector", pinnedHost: options.pinnedHost, hop },
        "Refusing a request that is not on the pinned host",
      );
      throw new UpstreamStatusError(502);
    }

    const response = await fetch(url, {
      signal: options.signal,
      redirect: "manual",
      // The freshness contract is ours (ADR 0014). A second cache with its own clock is the
      // two-clocks-disagreeing failure that makes an age display lie.
      cache: "no-store",
      headers: {
        accept: options.accept ?? "application/json",
        "user-agent": toolbenchUserAgent(),
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || hop >= maxRedirects) {
        throw new UpstreamStatusError(response.status, parseRetryAfter(response.headers.get("retry-after")));
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
      throw new UpstreamStatusError(response.status, parseRetryAfter(response.headers.get("retry-after")));
    }

    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      logger.warn(
        { scope: "toolbench.connector", declared, maxBytes },
        "Upstream declared a payload over the cap",
      );
      throw new UpstreamStatusError(502);
    }

    const text = await response.text();
    if (text.length > maxBytes) {
      logger.warn({ scope: "toolbench.connector", maxBytes }, "Upstream payload exceeded the cap");
      throw new UpstreamStatusError(502);
    }

    return { text, status: response.status, contentType: response.headers.get("content-type") };
  }
}

/** JSON decode. A body that is not JSON is a shape change, which degrades the tool honestly. */
export function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 502: no usable payload arrived. The parse error is not logged — it quotes the body.
    throw new UpstreamStatusError(502);
  }
}

/* ------------------------------------------------------------------ *
 * Envelope -> what the browser gets
 * ------------------------------------------------------------------ */

/**
 * Map a connector envelope onto the shape a Client Component renders.
 *
 * `reason` passes straight through now that `DegradedReason` and `DEGRADED_REASONS` carry the
 * same six members. It used to be narrowed by hand into a shorter union, which silently
 * collapsed anything unrecognised to `upstream-down` — so the day a new reason was added, the
 * Toolbench would have blamed the upstream for it. `connector-envelope.test.ts` asserts the
 * two lists stay identical.
 *
 * `lastError` is written by `runtime.ts` and is always a sentence we composed — never an
 * upstream body, never a stack, never a URL. That is why it can be returned to the browser
 * verbatim.
 */
export function toLookupOutcome<T>(envelope: ConnectorEnvelope<T>): LookupOutcome<T> {
  if (envelope.data !== null && envelope.fetchedAt !== null) {
    return {
      status: "ok",
      data: envelope.data,
      fetchedAt: envelope.fetchedAt.toISOString(),
      stale: envelope.state === "stale",
      attribution: envelope.attribution,
      note: envelope.state === "stale" ? envelope.lastError : null,
    };
  }

  return {
    status: "unavailable",
    reason: envelope.reason ?? "upstream-down",
    message: envelope.lastError ?? "This source could not be reached just now.",
    attribution: envelope.attribution,
  };
}

/**
 * An input we refused. **Nothing was requested**, which is what `bad-request` means and why
 * it is not `upstream-down`: no third party was involved and none should be blamed.
 */
export function invalidInput(message: string): LookupOutcome<never> {
  return { status: "unavailable", reason: "bad-request", message, attribution: null };
}

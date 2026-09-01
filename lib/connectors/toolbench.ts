import { headers } from "next/headers";

import brand from "@/config/brand";
import type { Connector } from "@/db/schema";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { getConnectorBySlug } from "@/lib/queries/live";
import { clientSubject } from "@/lib/rate-limit";
import { isPinnedHost } from "@/lib/toolbench/net-target";
import type { LookupFailureReason, LookupOutcome } from "@/lib/toolbench/lookup";

import { parseRetryAfter, runConnector, UpstreamStatusError } from "./runtime";
import type { ActorIdentity, ConnectorDriver, ConnectorEnvelope } from "./types";

/**
 * The shared runner and HTTP path for the four Toolbench connectors.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN CALLING `runConnector` DIRECTLY
 * ─────────────────────────────────────────────────────────────────────────────
 * `runConnector` resolves its registry row through `getLiveConnector(driver.kind)`, which
 * returns the alphabetically first published, enabled row **of that kind**. That is correct
 * for the Live surfaces, where one kind means one source. It is wrong here: all four of
 * these sources are `kind = 'infrastructure'` (ADR 0024 merged sources and connectors into
 * one registry, and `infrastructure` is the kind that fits a certificate log, a resolver, a
 * routing registry and a web archive). Resolving by kind would silently serve the crt.sh row
 * to the RIPEstat driver — and it would do so *successfully*, with the wrong attribution and
 * the wrong quota, which is the worst kind of bug this registry can produce.
 *
 * So the row is resolved **by slug** and handed to `runConnector` through `RunOptions`. The
 * four live conditions `getLiveConnector` would have applied are re-applied here, in the
 * same order and with the same fail-closed default, because passing `options.connector`
 * bypasses them. `lib/sources/governed.ts` reaches the identical conclusion from the poller
 * side and its `isLive` is deliberately the same four checks.
 *
 * `lib/connectors/runtime.ts`, `types.ts` and `audit.ts` are NOT modified by any of this.
 * The cleaner fix — a `slug` option on `runConnector` — is a change to a file this agent
 * does not own; it is written up in `docs/toolbench/HANDOFF-network-tools.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PER-USER QUOTA APPLIES HERE, UNLIKE THE POLLERS
 * ─────────────────────────────────────────────────────────────────────────────
 * `lib/sources/governed.ts` drops the per-user quota because a poller answers a timer and
 * there is no user. These are *user* queries — a person typed a domain and pressed a button
 * — so all four controls apply: kill-switch, global ceiling, per-user quota, audit row.
 * That is `runConnector` unmodified, which is why it is reused rather than reimplemented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS NEVER LOGGED
 * ─────────────────────────────────────────────────────────────────────────────
 * The domain, the IP, the URL. ADR 0013: the audit log records *that* a call happened,
 * never *what was asked for*. `connector_requests` has no column that could hold it, and
 * nothing in this file passes a query value to `logger`. A journalist's lookups must not be
 * reconstructable from our own records, and the only reliable way to guarantee that is for
 * the record never to exist.
 */

/** The `kind` all four Toolbench sources are registered under. See `db/schema.ts`. */
export const TOOLBENCH_CONNECTOR_KIND = "infrastructure" as const;

/**
 * The registry row, or a sentence explaining why we will not call this upstream.
 *
 * The four conditions, all fail-closed, mirroring `getLiveConnector`:
 *   `status = 'published'`, `enabled = true`, `terms_url` present, `legal_basis` present.
 */
function liveRefusal(connector: Connector | null, slug: string): string | null {
  if (!connector) {
    return `This source has no entry in the connector registry, so there is no recorded basis for calling it. Nothing was requested. (${slug})`;
  }
  if (!connector.enabled) {
    return `An operator has switched ${connector.name} off. Nothing was requested.`;
  }
  if (connector.status !== "published") {
    return `${connector.name} is registered but not yet published — an operator has to review its recorded terms and turn it on. Nothing was requested.`;
  }
  if (connector.termsUrl === null || connector.legalBasis === null) {
    return `${connector.name} has no recorded terms or legal basis, so it cannot be called. Nothing was requested.`;
  }
  return null;
}

/**
 * Run one Toolbench connector on behalf of a user.
 *
 * Never throws for an expected failure. Returns the same degraded envelope vocabulary the
 * Live surfaces use, so the tool page can say *what* is wrong — off, at its limit, refused
 * by the upstream, not answering — rather than showing a spinner that lies.
 */
export async function runToolConnector<Params, Result>(
  driver: ConnectorDriver<Params, Result>,
  rawParams: unknown,
  actor: ActorIdentity,
): Promise<ConnectorEnvelope<Result>> {
  let connector: Connector | null = null;
  try {
    connector = await getConnectorBySlug(driver.slug);
  } catch (error) {
    // We could not prove we are allowed to call. Fail closed, exactly as the poller does.
    logger.error(
      { scope: "toolbench.connector", slug: driver.slug, err: error },
      "Registry lookup failed; refusing to call upstream",
    );
    return {
      fetchedAt: null,
      state: "unavailable",
      data: null,
      connectorSlug: driver.slug,
      attribution: null,
      lastError: "The source registry is unavailable, so no lookup was authorised.",
      reason: "disabled",
    };
  }

  const refusal = liveRefusal(connector, driver.slug);
  if (refusal !== null) {
    logger.info({ scope: "toolbench.connector", slug: driver.slug }, "Connector not live; no call made");
    return {
      fetchedAt: null,
      state: "unavailable",
      data: null,
      connectorSlug: connector?.slug ?? driver.slug,
      attribution: connector?.attribution ?? null,
      lastError: refusal,
      reason: "disabled",
    };
  }

  // Non-null by construction: `liveRefusal` returns a string for every null case above.
  return runConnector(driver, rawParams, actor, { connector: connector as Connector });
}

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
 * The quota and audit subject for a Toolbench lookup.
 *
 * The signed-in user's id if there is one, otherwise the client IP. **Both are HMAC-hashed
 * before they reach `rate_limits` or `connector_requests`** (ADR 0009, ADR 0013), so nothing
 * identifying is stored on either side of the call. Identical construction to
 * `/live/flights`, deliberately: one way of identifying a caller in this codebase, not two.
 */
export async function toolbenchActor(): Promise<ActorIdentity> {
  const session = await auth();
  if (session?.user?.id) return { subject: session.user.id };
  const requestHeaders = await headers();
  return { subject: clientSubject(new Request("http://internal", { headers: requestHeaders })) };
}

/**
 * Map a connector envelope onto the four-outcome union the client renders.
 *
 * `lastError` is written by `runtime.ts` and by `runToolConnector`, and is always a sentence
 * we composed — never an upstream body, never a stack, never a URL. That is why it can be
 * returned to the browser verbatim.
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

  const reason: LookupFailureReason =
    envelope.reason === "disabled" ||
    envelope.reason === "quota-exhausted" ||
    envelope.reason === "rate-limited"
      ? envelope.reason
      : "upstream-down";

  return {
    status: "unavailable",
    reason,
    message: envelope.lastError ?? "This source could not be reached just now.",
    attribution: envelope.attribution,
  };
}

/** An input we refused. Nothing was requested, and the message says what to change. */
export function invalidInput(message: string): LookupOutcome<never> {
  return { status: "invalid", message };
}

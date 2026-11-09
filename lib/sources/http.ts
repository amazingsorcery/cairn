import brand from "@/config/brand";
import { logger } from "@/lib/logger";
import { readCappedText } from "@/lib/net/capped-body";
import { countOutboundRequest } from "@/lib/net/outbound-tally";
import { connectorHost, isPinnedHost } from "@/lib/toolbench/net-target";

import type { SourceFailure } from "./types";

/**
 * The one outbound HTTP path for `lib/sources` (worker polls; governance lives in
 * `governed.ts`).
 *
 *   1. A 429/420 opens a cooldown; no calls until it expires.
 *   2. Expected failures return typed values, never throw, so one dead upstream can't take
 *      down the map.
 *
 * Server-only: a browser poll would expose the reader's IP and viewport to a third party.
 */

/** jsdom defines `window` but still has `process`, so check both. */
const IN_BROWSER =
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof process === "undefined";

if (IN_BROWSER) {
  throw new Error(
    "lib/sources is server-only. Polling an upstream from the browser would send the " +
      "reader's IP and viewport to a third party. Poll it from the worker or a Route " +
      "Handler instead.",
  );
}

/** Default per-request budget. Individual adapters raise it where a payload is large. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Identifies us (not the viewer) on every call; NWS returns 403 without it. Built from
 * `config/brand.ts`; `SOURCE_CONTACT_EMAIL` overrides the placeholder contact address.
 */
export function sourceUserAgent(
  env: (name: string) => string | undefined = (name) => process.env[name],
): string {
  const contact = env("SOURCE_CONTACT_EMAIL")?.trim() || brand.email.support;
  return `${brand.nameLower}-live/1.0 (+${contact})`;
}

/* ------------------------------------------------------------------ *
 * Per-source cooldown
 * ------------------------------------------------------------------ */

const globalForCooldown = globalThis as typeof globalThis & {
  __cairnSourceCooldown__?: Map<string, Date>;
};
const cooldownUntil: Map<string, Date> = (globalForCooldown.__cairnSourceCooldown__ ??=
  new Map());

const globalForLastGood = globalThis as typeof globalThis & {
  __cairnSourceLastGood__?: Map<string, Date>;
};
const lastGood: Map<string, Date> = (globalForLastGood.__cairnSourceLastGood__ ??= new Map());

/**
 * Status of each source's most recent request, so the audit row in `governed.ts` carries the
 * real `upstream_status` (`SourceResult` has no place for it). Multi-call polls keep the last.
 */
const globalForStatus = globalThis as typeof globalThis & {
  __cairnSourceStatus__?: Map<string, number>;
};
const lastStatus: Map<string, number> = (globalForStatus.__cairnSourceStatus__ ??= new Map());

/** Status of the most recent attempt for this source, or null if none has been made. */
export function lastUpstreamStatus(slug: string): number | null {
  return lastStatus.get(slug) ?? null;
}

/**
 * Record a status against a slug that didn't make the request. Used by the cameras adapter,
 * which fetches under per-provider slugs (separate cooldowns) but is audited per adapter.
 */
export function recordUpstreamStatus(slug: string, status: number): void {
  lastStatus.set(slug, status);
}

/** Used when a 429 has no `Retry-After`. Longer than any adapter TTL. */
export const DEFAULT_COOLDOWN_SECONDS = 120;

/** Seconds remaining before this source may call upstream again, or 0. */
export function cooldownRemaining(slug: string, now: Date = new Date()): number {
  const until = cooldownUntil.get(slug);
  if (!until) return 0;
  const remaining = Math.ceil((until.getTime() - now.getTime()) / 1000);
  if (remaining <= 0) {
    cooldownUntil.delete(slug);
    return 0;
  }
  return remaining;
}

export function openCooldown(slug: string, seconds: number, now: Date = new Date()): void {
  const until = new Date(now.getTime() + Math.max(1, seconds) * 1000);
  const existing = cooldownUntil.get(slug);
  // Never shorten an open cooldown.
  if (!existing || until > existing) cooldownUntil.set(slug, until);
}

/** When this source last produced a usable payload in this process, or null. */
export function lastGoodAt(slug: string): Date | null {
  return lastGood.get(slug) ?? null;
}

export function recordGood(slug: string, at: Date): void {
  lastGood.set(slug, at);
}

/** Test seam. In-process state only — nothing here is persisted. */
export function resetSourceRuntime(): void {
  cooldownUntil.clear();
  lastGood.clear();
  lastStatus.clear();
}

/* ------------------------------------------------------------------ *
 * Rate-limit headers
 * ------------------------------------------------------------------ */

/** 429 and Twitter-style 420. Anything else is an ordinary upstream error. */
export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 420;
}

/** `Retry-After` as delta-seconds or HTTP-date, capped at an hour. Read on any non-2xx. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3_600) : null;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  const seconds = Math.ceil((when - now.getTime()) / 1000);
  return seconds > 0 ? Math.min(seconds, 3_600) : 0;
}

/* ------------------------------------------------------------------ *
 * The request
 * ------------------------------------------------------------------ */

export type HttpOutcome =
  | { readonly ok: true; readonly status: number; readonly text: string }
  | { readonly ok: false; readonly failure: SourceFailure };

export type FetchOptions = {
  readonly slug: string;
  readonly url: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Max bytes to read, so a misbehaving upstream can't exhaust worker memory. */
  readonly maxBytes?: number;
  /**
   * Only host this request may reach, checked before the request and on every redirect hop.
   * Defaults to the host of `url` (adapters build URLs from constants). radio-browser's
   * discovered host is validated against its domain pattern first.
   */
  readonly pinnedHost?: string;
  /** Same-host redirect hops to follow; enough for trailing-slash tidying, small enough to end loops. */
  readonly maxRedirects?: number;
};

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

/** Host of a URL, or `null` if unparseable (which refuses the request: can't pin it). */
function safeHost(url: string): string | null {
  try {
    return connectorHost(url);
  } catch {
    return null;
  }
}

/**
 * One GET with timeout, byte cap and typed failures. Returns text, since some upstreams serve
 * CSV or plain text and the adapter decodes.
 */
export async function fetchUpstream(options: FetchOptions): Promise<HttpOutcome> {
  const { slug, url, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const waiting = cooldownRemaining(slug);
  if (waiting > 0) {
    return { ok: false, failure: { kind: "rateLimited", retryAfterSeconds: waiting } };
  }

  // Combined by hand rather than `AbortSignal.any` so we know whether timeout or caller fired.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal.addEventListener("abort", onCallerAbort, { once: true });

  try {
    /*
     * Redirect pin: `redirect: "manual"` and every hop re-checked with `isPinnedHost` (shared
     * with the connector primitive; also refuses scheme downgrade, userinfo and non-443
     * ports). An open redirect upstream could otherwise point us at cloud metadata.
     */
    const pinnedHost = options.pinnedHost ?? safeHost(url);
    const maxRedirects = options.maxRedirects ?? 3;

    let target = url;
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      if (pinnedHost === null || !isPinnedHost(target, pinnedHost)) {
        /*
         * Nothing is sent. `redirected` is its own kind so "they moved" isn't reported as
         * "they're down". The destination host goes to the log only (upstream-controlled text).
         */
        logger.error(
          {
            scope: "source.http",
            slug,
            reason: "offHostRedirect",
            pinnedHost,
            // Hostname only; the path can echo the query.
            redirectHost: safeHost(target),
            hop,
          },
          "Upstream redirected off its pinned host; refused rather than followed",
        );
        return { ok: false, failure: { kind: "redirected" } };
      }

      // Count every request, including redirect hops, for the audit row.
      countOutboundRequest();
      response = await fetch(target, {
        signal: controller.signal,
        redirect: "manual",
        // Our own cache owns freshness; avoid a second cache clock.
        cache: "no-store",
        headers: {
          accept: "application/json",
          "user-agent": sourceUserAgent(),
          ...options.headers,
        },
      });

      if (response.status < 300 || response.status >= 400) break;

      // Record the 3xx so the audit row has the real status.
      lastStatus.set(slug, response.status);

      const location = response.headers.get("location");
      if (location === null || hop >= maxRedirects) {
        return {
          ok: false,
          failure: {
            kind: "upstreamError",
            status: response.status,
            message: `upstream returned HTTP ${response.status} without a followable location`,
          },
        };
      }
      // Resolve relative Location against the current URL; the pin is re-checked next loop.
      target = new URL(location, target).toString();
      await response.body?.cancel();
    }

    // Recorded before branching so every status reaches the audit row.
    lastStatus.set(slug, response.status);

    if (isRateLimitStatus(response.status)) {
      const retryAfter =
        parseRetryAfter(response.headers.get("retry-after")) ?? DEFAULT_COOLDOWN_SECONDS;
      openCooldown(slug, retryAfter);
      return { ok: false, failure: { kind: "rateLimited", retryAfterSeconds: retryAfter } };
    }

    if (!response.ok) {
      // Honour Retry-After on any non-2xx.
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter !== null) openCooldown(slug, retryAfter);
      return {
        ok: false,
        failure: {
          kind: "upstreamError",
          status: response.status,
          // Never the response body (upstream-controlled; would reach logs and pages).
          message: `upstream returned HTTP ${response.status}`,
        },
      };
    }

    // Cap applied to the stream: `Content-Length` may be absent or describe compressed bytes.
    const capped = await readCappedText(response, maxBytes);
    if (!capped.ok) {
      return {
        ok: false,
        failure: {
          kind: "upstreamError",
          status: response.status,
          message:
            capped.reason === "declared"
              ? `payload ${capped.bytes} bytes exceeds the ${maxBytes} byte cap`
              : `payload exceeded the ${maxBytes} byte cap and was cut off at ${capped.bytes} bytes`,
        },
      };
    }

    return { ok: true, status: response.status, text: capped.text };
  } catch (error) {
    if (timedOut) return { ok: false, failure: { kind: "timeout", afterMs: timeoutMs } };
    if (signal.aborted) {
      return { ok: false, failure: { kind: "disabled", reason: "poll cancelled" } };
    }
    return {
      ok: false,
      failure: {
        kind: "upstreamError",
        // A transport error has no status. `message` is ours, not the upstream's.
        message: error instanceof Error ? `network error: ${error.name}` : "network error",
      },
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
  }
}

/** JSON decode as a typed failure rather than a throw. */
export function decodeJson(text: string): { ok: true; body: unknown } | { ok: false; failure: SourceFailure } {
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      failure: { kind: "schemaChanged", message: "upstream response was not valid JSON" },
    };
  }
}

/**
 * Read an API key via the context's env reader (not `process.env`, for testability). A
 * missing key returns `notConfigured` naming the variable, disabling only that layer.
 */
export function requireApiKey(
  env: (name: string) => string | undefined,
  envVar: string,
): { ok: true; key: string } | { ok: false; failure: SourceFailure } {
  const key = env(envVar)?.trim();
  if (!key) return { ok: false, failure: { kind: "notConfigured", missingEnvVar: envVar } };
  return { ok: true, key };
}

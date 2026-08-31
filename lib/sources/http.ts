import brand from "@/config/brand";

import type { SourceFailure } from "./types";

/**
 * The one outbound HTTP path for `lib/sources`.
 *
 * This is a generalisation of `lib/connectors/runtime.ts`, not a replacement for it. The
 * connector seam answers a *user's* request and therefore carries per-user quota, an audit
 * log and a registry row (ADR 0011–0014). A source adapter is polled by the worker on a
 * timer with no user attached (ADR 0019), so per-user quota and the audit log do not apply —
 * but the two lessons that cost us a QA finding do, and they are reimplemented here:
 *
 *   1. **Their limiter is the authority, not our TTL.** A 429 opens a cooldown and we stop
 *      calling until it expires. Q-02 recorded 57 refusals from adsb.lol because nothing
 *      backed off; the TTL alone did not save us and will not save us here.
 *   2. **Nothing throws for an expected failure.** Every path returns a typed value, because
 *      an exception crossing a layer boundary is how one dead upstream takes down a map
 *      (product-brief §2b).
 *
 * SERVER-ONLY. A source poll from the browser would hand the reader's IP and the patch of
 * the world they are looking at to a third party — the interest-graph leak product-brief
 * §3.2 constraint 4 exists to prevent.
 */

/**
 * jsdom (Vitest's environment) defines `window` while still running under Node, so `window`
 * alone is not the test. `process.versions.node` is present in every server runtime and in
 * jsdom, and absent in a browser bundle. Same check as `lib/connectors/runtime.ts`.
 */
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
 * Identify ourselves on every outbound call.
 *
 * Courtesy and self-interest both: an operator who needs to rate-limit or contact us can do
 * so instead of blocking an anonymous pattern — and NOAA/NWS *requires* a User-Agent that
 * identifies the application, returning 403 to the default agent. It says nothing about the
 * person viewing the page.
 *
 * The brand name and contact address come from `config/brand.ts` (product-brief §7 — never
 * hardcode a brand string). The mailbox on the placeholder domain does not exist yet, so
 * `SOURCE_CONTACT_EMAIL` lets an operator substitute a real one without a code change. That
 * matters more than usual here: an upstream that cannot reach us blocks us silently.
 */
export function sourceUserAgent(): string {
  const contact = process.env.SOURCE_CONTACT_EMAIL?.trim() || brand.email.support;
  return `${brand.nameLower}-live/1.0 (+${contact})`;
}

/* ------------------------------------------------------------------ *
 * Per-source cooldown — the lesson from QA finding Q-02
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
 * Used when a 429 carries no `Retry-After`. Deliberately longer than any adapter's TTL: an
 * upstream that refused us needs materially longer to refill than our own poll interval, and
 * backing off for less than one interval just re-enters the burst that caused the refusal.
 */
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
  // Never shorten a cooldown already open: a later, shorter refusal must not let us back in.
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
}

/* ------------------------------------------------------------------ *
 * Rate-limit headers
 * ------------------------------------------------------------------ */

/** 429 and Twitter-style 420. Anything else is an ordinary upstream error. */
export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 420;
}

/**
 * `Retry-After` in either documented form: delta-seconds, or an HTTP-date. Read on EVERY
 * non-2xx rather than only on 429, because a 503 may carry one too and a header we were
 * given always beats a constant we chose.
 */
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
  /**
   * Bytes we will read before giving up. Adapters return small JSON (product-brief §2b);
   * a cap means a misbehaving or redirected upstream cannot exhaust the worker's memory.
   */
  readonly maxBytes?: number;
};

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

/**
 * One GET, with a timeout, a byte cap and typed failures.
 *
 * Returns TEXT rather than parsed JSON on purpose: several of these upstreams serve CSV or
 * plain-text TLE, and the adapter that knows the format should be the one that decodes it.
 */
export async function fetchUpstream(options: FetchOptions): Promise<HttpOutcome> {
  const { slug, url, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const waiting = cooldownRemaining(slug);
  if (waiting > 0) {
    return { ok: false, failure: { kind: "rateLimited", retryAfterSeconds: waiting } };
  }

  /**
   * The caller's signal and our timeout are combined by hand rather than with
   * `AbortSignal.any`, for one reason worth the extra lines: we need to know WHICH fired.
   * A timeout and a shutdown are different states to a reader — "the source is slow" versus
   * "we stopped asking" — and `AbortError` alone cannot tell them apart.
   */
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      // The freshness contract is ours (ADR 0014). A second cache with its own clock is the
      // two-clocks-disagreeing failure that makes an age display lie.
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": sourceUserAgent(),
        ...options.headers,
      },
    });

    if (isRateLimitStatus(response.status)) {
      const retryAfter =
        parseRetryAfter(response.headers.get("retry-after")) ?? DEFAULT_COOLDOWN_SECONDS;
      openCooldown(slug, retryAfter);
      return { ok: false, failure: { kind: "rateLimited", retryAfterSeconds: retryAfter } };
    }

    if (!response.ok) {
      // A Retry-After on any non-2xx is still an instruction. Obey it.
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      if (retryAfter !== null) openCooldown(slug, retryAfter);
      return {
        ok: false,
        failure: {
          kind: "upstreamError",
          status: response.status,
          // Never the response body: it is attacker- or upstream-controlled text that would
          // end up in a log and, worse, on a page.
          message: `upstream returned HTTP ${response.status}`,
        },
      };
    }

    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return {
        ok: false,
        failure: {
          kind: "upstreamError",
          status: response.status,
          message: `payload ${declared} bytes exceeds the ${maxBytes} byte cap`,
        },
      };
    }

    const text = await response.text();
    if (text.length > maxBytes) {
      return {
        ok: false,
        failure: {
          kind: "upstreamError",
          status: response.status,
          message: `payload exceeds the ${maxBytes} byte cap`,
        },
      };
    }

    return { ok: true, status: response.status, text };
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
 * Read an API key from the environment.
 *
 * Returns a `notConfigured` failure naming the variable rather than throwing, so a
 * deployment missing one key disables one layer and the rest of the map comes up. ADR 0018:
 * the build must not require runtime secrets.
 */
export function requireApiKey(
  envVar: string,
): { ok: true; key: string } | { ok: false; failure: SourceFailure } {
  const key = process.env[envVar]?.trim();
  if (!key) return { ok: false, failure: { kind: "notConfigured", missingEnvVar: envVar } };
  return { ok: true, key };
}

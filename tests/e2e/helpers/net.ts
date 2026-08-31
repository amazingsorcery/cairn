import type { Page } from "@playwright/test";

/**
 * Outbound-request accounting.
 *
 * ADR 0011 and ADR 0015 make "which origins does the browser talk to" a *product* property,
 * not a performance one: a connection to a camera operator tells that operator which patch
 * of the world a reader is looking at, and a connection to a tile server tells the tile
 * server the same thing. Those guarantees are one well-meaning `<link rel=preconnect>` away
 * from being false, and nothing in the type system or the linter would notice.
 *
 * So the tests treat **any** request whose origin is not the application's own origin as
 * outbound. That is deliberately stricter than "an operator origin": a regression is more
 * likely to arrive as a font CDN, an analytics beacon or a preconnect than as a literal
 * `jamcams.tfl.gov.uk` reference, and product-brief §3.2 forbids the first two outright.
 */

/** `data:`, `blob:` and `about:` never leave the machine and are not outbound. */
const LOCAL_SCHEMES = ["data:", "blob:", "about:", "chrome-extension:", "chrome:"];

export function isOutbound(url: string, baseURL: string): boolean {
  if (LOCAL_SCHEMES.some((scheme) => url.startsWith(scheme))) return false;
  try {
    return new URL(url).origin !== new URL(baseURL).origin;
  } catch {
    return false;
  }
}

export interface OutboundRecorder {
  /** Every outbound URL seen so far, in order. */
  readonly urls: readonly string[];
  /** Outbound URLs whose origin matches `origin`. */
  matching(origin: string): string[];
  /** Forget everything recorded so far — used to separate "on load" from "after a click". */
  reset(): void;
}

/**
 * Record every outbound request the page makes, and optionally **abort** them.
 *
 * Aborting matters: a recorder alone proves the request was attempted but still lets the
 * connection happen, which for a privacy assertion means the test has already done the thing
 * it is asserting nobody does. `block: true` records *and* refuses, so a regression fails the
 * test without leaking the reader's IP to the operator on the way.
 *
 * `allow` is an origin allowlist consulted only while blocking — used by the click-to-load
 * test, which stubs the operator's image rather than letting the request reach them.
 */
export async function watchOutbound(
  page: Page,
  baseURL: string,
  options: { block?: boolean } = {},
): Promise<OutboundRecorder> {
  let urls: string[] = [];

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isOutbound(url, baseURL)) {
      await route.continue();
      return;
    }
    urls.push(url);
    if (options.block) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  return {
    get urls() {
      return urls;
    },
    matching(origin: string) {
      return urls.filter((url) => {
        try {
          return new URL(url).origin === origin;
        } catch {
          return false;
        }
      });
    },
    reset() {
      urls = [];
    },
  };
}

/** A 1x1 transparent PNG, used to stand in for an operator-hosted camera frame. */
export const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

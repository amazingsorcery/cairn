import type { Page } from "@playwright/test";

/**
 * Outbound-request accounting. Which origins the browser contacts is a privacy property
 * (an operator learns what a reader looks at), so any non-app origin counts as outbound,
 * including font CDNs, analytics and preconnects.
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
 * Record every outbound request, optionally aborting it (`block: true`) so a regression
 * doesn't actually reach the third party.
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

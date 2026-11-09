import { describe, expect, it } from "vitest";

import {
  AUTHJS_DEFAULT_MAX_AGE_SECONDS,
  formatLinkLifetime,
  resolveMaxAgeSeconds,
} from "./magic-link-max-age";

/**
 * `Nodemailer()` from `@auth/core` hardcodes `maxAge: 24h` and puts the caller's config
 * under `options`, which Auth.js merges over the defaults at request time. So
 * `provider.maxAge` is the factory default, not what `lib/auth.ts` configured.
 *
 * The fixtures below match the factory's real output shape.
 */

/** Exactly what `Nodemailer({ ..., maxAge })` returns from `@auth/core`. */
function nodemailerProvider(configuredMaxAge?: number) {
  return {
    id: "nodemailer",
    type: "email",
    name: "Nodemailer",
    // The factory's default; the caller's value is not merged in here.
    maxAge: 24 * 60 * 60,
    options: configuredMaxAge === undefined ? {} : { maxAge: configuredMaxAge },
  };
}

const githubProvider = { id: "github", type: "oauth", name: "GitHub", options: {} };

describe("resolveMaxAgeSeconds", () => {
  it("prefers what lib/auth.ts configured over the provider factory's default", () => {
    // 900 must win over the hardcoded 86400.
    expect(resolveMaxAgeSeconds([nodemailerProvider(15 * 60)])).toBe(900);
  });

  it("falls back to the factory default when nothing was configured", () => {
    expect(resolveMaxAgeSeconds([nodemailerProvider()])).toBe(24 * 60 * 60);
  });

  it("finds the email provider past other providers", () => {
    expect(resolveMaxAgeSeconds([githubProvider, nodemailerProvider(600)])).toBe(600);
  });

  it("returns null when no email provider is configured, rather than guessing 24 hours", () => {
    // A guessed 24h would be indistinguishable from a correct read.
    expect(resolveMaxAgeSeconds([githubProvider])).toBeNull();
    expect(resolveMaxAgeSeconds([])).toBeNull();
  });

  it("returns null for a factory-supplied provider and for junk values", () => {
    // Unreadable shapes; null lets the page omit the duration.
    expect(resolveMaxAgeSeconds([() => nodemailerProvider(300)])).toBeNull();
    expect(resolveMaxAgeSeconds([{ type: "email", options: { maxAge: 0 } }])).toBeNull();
    expect(resolveMaxAgeSeconds([{ type: "email", options: { maxAge: "900" } }])).toBeNull();
    expect(resolveMaxAgeSeconds([null, undefined, "nope"])).toBeNull();
  });

  it("never returns the Auth.js default as a guess", () => {
    // Fails if a default fallback is added.
    for (const providers of [[githubProvider], [], [null], [() => nodemailerProvider(300)]]) {
      expect(resolveMaxAgeSeconds(providers)).not.toBe(AUTHJS_DEFAULT_MAX_AGE_SECONDS);
    }
  });
});

describe("formatLinkLifetime", () => {
  it("returns null when the lifetime is unknown, so callers can omit it", () => {
    expect(formatLinkLifetime(null)).toBeNull();
  });

  it("renders whole units, and minutes below an hour and a half", () => {
    expect(formatLinkLifetime(15 * 60)).toBe("15 minutes");
    expect(formatLinkLifetime(60)).toBe("1 minute");
    expect(formatLinkLifetime(60 * 60)).toBe("60 minutes");
    expect(formatLinkLifetime(90 * 60)).toBe("2 hours");
    expect(formatLinkLifetime(2 * 60 * 60)).toBe("2 hours");
    expect(formatLinkLifetime(24 * 60 * 60)).toBe("24 hours");
  });
});

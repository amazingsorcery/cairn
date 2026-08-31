import { describe, expect, it } from "vitest";

import { formatLinkLifetime, resolveMaxAgeSeconds } from "./magic-link-max-age";

/**
 * The sign-in copy states how long a magic link lasts (`docs/design/states.md` §6.4, §6.5).
 * These tests exist because that sentence was WRONG in a shipped build, in the dangerous
 * direction: it told people their link lasted 24 hours when it expired in 15 minutes.
 *
 * The cause was precedence. `Nodemailer()` from `@auth/core` returns its own defaults —
 * including a hardcoded `maxAge: 24 * 60 * 60` — and puts the caller's config under a
 * separate `options` key. Auth.js merges `options` OVER the defaults at request time
 * (`@auth/core/lib/utils/providers.js`). Reading `provider.maxAge` therefore returns the
 * factory default and silently discards what `lib/auth.ts` configured; it only became
 * visible when the two stopped agreeing.
 *
 * The fixtures below are the real shape of that factory's output.
 */

/** Exactly what `Nodemailer({ ..., maxAge })` returns from `@auth/core`. */
function nodemailerProvider(configuredMaxAge?: number) {
  return {
    id: "nodemailer",
    type: "email",
    name: "Nodemailer",
    // The factory hardcodes its own default here and does NOT merge the caller's value in.
    maxAge: 24 * 60 * 60,
    options: configuredMaxAge === undefined ? {} : { maxAge: configuredMaxAge },
  };
}

const githubProvider = { id: "github", type: "oauth", name: "GitHub", options: {} };

describe("resolveMaxAgeSeconds", () => {
  it("prefers what lib/auth.ts configured over the provider factory's default", () => {
    // The regression: 900 must win over the hardcoded 86400 sitting next to it.
    expect(resolveMaxAgeSeconds([nodemailerProvider(15 * 60)])).toBe(900);
  });

  it("falls back to the factory default when nothing was configured", () => {
    expect(resolveMaxAgeSeconds([nodemailerProvider()])).toBe(24 * 60 * 60);
  });

  it("finds the email provider past other providers", () => {
    expect(resolveMaxAgeSeconds([githubProvider, nodemailerProvider(600)])).toBe(600);
  });

  it("falls back when no email provider is configured at all", () => {
    expect(resolveMaxAgeSeconds([githubProvider])).toBe(24 * 60 * 60);
    expect(resolveMaxAgeSeconds([])).toBe(24 * 60 * 60);
  });

  it("ignores a provider supplied as a factory function, and junk values", () => {
    expect(resolveMaxAgeSeconds([() => nodemailerProvider(300)])).toBe(24 * 60 * 60);
    expect(resolveMaxAgeSeconds([{ type: "email", options: { maxAge: 0 } }])).toBe(24 * 60 * 60);
    expect(resolveMaxAgeSeconds([{ type: "email", options: { maxAge: "900" } }])).toBe(24 * 60 * 60);
    expect(resolveMaxAgeSeconds([null, undefined, "nope"])).toBe(24 * 60 * 60);
  });
});

describe("formatLinkLifetime", () => {
  it("renders whole units, and minutes below an hour and a half", () => {
    expect(formatLinkLifetime(15 * 60)).toBe("15 minutes");
    expect(formatLinkLifetime(60)).toBe("1 minute");
    expect(formatLinkLifetime(60 * 60)).toBe("60 minutes");
    expect(formatLinkLifetime(90 * 60)).toBe("2 hours");
    expect(formatLinkLifetime(2 * 60 * 60)).toBe("2 hours");
    expect(formatLinkLifetime(24 * 60 * 60)).toBe("24 hours");
  });
});

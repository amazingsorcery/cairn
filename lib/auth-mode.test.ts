import { describe, expect, it } from "vitest";

import { deriveSignInMode, PUBLIC_ONLY_NOTICE, SIGN_IN_ENABLED_NOTICE } from "./auth-mode";

/**
 * The derivation that decides whether this deployment has a signed-in surface at all.
 *
 * There is deliberately NO flag an operator sets. A flag is a second source of truth that
 * disagrees with the first the moment somebody adds SMTP and forgets to flip it — and the
 * failure mode is the worst one available: a site that renders sign-in controls nobody can
 * use, or hides a sign-in that works. The configuration IS the mode.
 */

const github = { AUTH_GITHUB_ID: "client-id", AUTH_GITHUB_SECRET: "client-secret" };
const smtp = { SMTP_HOST: "smtp.example.test", SMTP_FROM: "no-reply@example.test" };

describe("deriveSignInMode", () => {
  it("reports public-only when nothing is configured", () => {
    const mode = deriveSignInMode({});
    expect(mode).toEqual({ github: false, email: false, enabled: false, publicOnly: true });
  });

  it("reports GitHub alone as an enabled sign-in", () => {
    const mode = deriveSignInMode({ ...github });
    expect(mode).toEqual({ github: true, email: false, enabled: true, publicOnly: false });
  });

  it("reports SMTP alone as an enabled sign-in", () => {
    const mode = deriveSignInMode({ ...smtp });
    expect(mode).toEqual({ github: false, email: true, enabled: true, publicOnly: false });
  });

  it("reports both when both are configured", () => {
    const mode = deriveSignInMode({ ...github, ...smtp });
    expect(mode).toEqual({ github: true, email: true, enabled: true, publicOnly: false });
  });

  /**
   * The schema refuses to boot on a half-configured provider, so a running process never
   * reaches this. Middleware reads raw `process.env` though, where an empty string is what
   * an operator who "cleared" a variable in `.env` actually leaves behind — and
   * `Boolean("")` is the only reason that is not a half-open door.
   */
  it("treats an empty or whitespace value as unset", () => {
    expect(deriveSignInMode({ AUTH_GITHUB_ID: "", AUTH_GITHUB_SECRET: "" }).github).toBe(false);
    expect(deriveSignInMode({ SMTP_HOST: "   ", SMTP_FROM: "  " }).email).toBe(false);
  });

  it("treats a half-configured provider as unusable rather than as usable", () => {
    expect(deriveSignInMode({ AUTH_GITHUB_ID: "client-id" }).github).toBe(false);
    expect(deriveSignInMode({ SMTP_HOST: "smtp.example.test" }).email).toBe(false);
    expect(deriveSignInMode({ AUTH_GITHUB_ID: "client-id" }).publicOnly).toBe(true);
  });
});

describe("the startup notice", () => {
  it("names both routes to a working sign-in, so the operator need not read the schema", () => {
    expect(PUBLIC_ONLY_NOTICE).toContain("AUTH_GITHUB_ID");
    expect(PUBLIC_ONLY_NOTICE).toContain("AUTH_GITHUB_SECRET");
    expect(PUBLIC_ONLY_NOTICE).toContain("SMTP_");
    expect(PUBLIC_ONLY_NOTICE).toContain(".env.example");
  });

  it("says which surfaces are absent rather than merely that a mode is on", () => {
    expect(PUBLIC_ONLY_NOTICE).toMatch(/workspace/i);
  });

  it("has a counterpart line for the configured case", () => {
    expect(SIGN_IN_ENABLED_NOTICE).toMatch(/sign-in/i);
  });

  /** A brand string in a log line is a brand string outside `config/brand.ts`. */
  it("names no product", () => {
    expect(PUBLIC_ONLY_NOTICE).not.toMatch(/cairn/i);
    expect(SIGN_IN_ENABLED_NOTICE).not.toMatch(/cairn/i);
  });
});

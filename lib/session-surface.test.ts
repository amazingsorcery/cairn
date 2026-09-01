import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SignInMode } from "./auth-mode";

/**
 * The guard that makes the signed-in surface ABSENT rather than broken.
 *
 * `notFound()` and not `redirect("/signin")`: in public-only mode `/signin` is itself not
 * served, so a redirect would land the reader on a 404 by a longer route, having first told
 * them a sign-in exists. And not a 403 either — the rest of this codebase answers "you may
 * not" and "there is nothing here" identically on purpose (`components/admin/guard.ts`), and
 * a deployment with no accounts genuinely has nothing there.
 */

/** Mutable so both modes can be exercised in one file; read through a getter by the mock. */
let mode: SignInMode = { github: false, email: false, enabled: false, publicOnly: true };

vi.mock("./env", () => ({
  get authProviders(): SignInMode {
    return mode;
  },
}));

const { isSignInEnabled, requireSignInEnabled } = await import("./session-surface");

/** What `notFound()` throws in Next 15: an Error carrying this digest. */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

describe("public-only mode", () => {
  beforeEach(() => {
    mode = { github: false, email: false, enabled: false, publicOnly: true };
  });

  it("reports sign-in as unavailable", () => {
    expect(isSignInEnabled()).toBe(false);
  });

  it("answers a request for the signed-in surface with 404", () => {
    expect(() => requireSignInEnabled()).toThrow(NOT_FOUND);
  });
});

describe("with a provider configured", () => {
  beforeEach(() => {
    mode = { github: true, email: false, enabled: true, publicOnly: false };
  });

  it("reports sign-in as available", () => {
    expect(isSignInEnabled()).toBe(true);
  });

  it("lets the signed-in surface through untouched", () => {
    expect(() => requireSignInEnabled()).not.toThrow();
  });

  it("is decided per call, not captured once at import", () => {
    // Otherwise the guard would answer with whatever the module graph saw first, which in a
    // long-lived server is right by luck rather than by construction.
    expect(isSignInEnabled()).toBe(true);
    mode = { github: false, email: false, enabled: false, publicOnly: true };
    expect(isSignInEnabled()).toBe(false);
  });
});

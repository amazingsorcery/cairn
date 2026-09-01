import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { middleware } from "./middleware";

/**
 * Middleware's redirect convenience, and the one case where it must not fire.
 *
 * In public-only mode `/signin` is not served, so redirecting a signed-out visitor there
 * would replace a clean 404 with a redirect to a 404 — and would tell them, on the way, that
 * an account is possible here. The route guards answer instead.
 *
 * WHY THIS READS `process.env` DIRECTLY rather than importing `lib/env`: middleware runs in
 * the Edge sandbox, which is handed a snapshot of the real `process.env` at request time
 * (`next/dist/server/web/sandbox/context.js`) but has no `pg` and no Node built-ins. Only
 * `NEXT_PUBLIC_*` values are inlined at build time, so a plain read here is a runtime read —
 * which matters, because the image is built without secrets and given them at `docker run`.
 */

const AUTH_KEYS = ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "SMTP_HOST", "SMTP_FROM"] as const;

function clearProviders(): void {
  for (const key of AUTH_KEYS) delete process.env[key];
}

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new URL(path, "https://example.test"));
  if (cookie) req.cookies.set("authjs.session-token", cookie);
  return req;
}

/**
 * The suite's default environment configures GitHub OAuth (see `vitest.config.ts`), which is
 * the right default everywhere else and the wrong one here. Each block sets the state it is
 * about, explicitly, and hands the process back afterwards.
 */
beforeEach(() => {
  clearProviders();
});

afterEach(() => {
  clearProviders();
});

describe("with a sign-in method configured", () => {
  function configure(): void {
    process.env.AUTH_GITHUB_ID = "client-id";
    process.env.AUTH_GITHUB_SECRET = "client-secret";
  }

  for (const path of ["/workspaces", "/workspaces/new", "/admin", "/admin/queue"]) {
    it(`sends a signed-out visitor from ${path} to /signin, carrying the path back`, () => {
      configure();
      const response = middleware(request(path));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe("/signin");
      expect(location.searchParams.get("callbackUrl")).toBe(path);
    });
  }

  it("passes a visitor holding a session cookie through, uncacheable", () => {
    configure();
    const response = middleware(request("/workspaces", "not-a-real-token"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

describe("public-only mode", () => {
  for (const path of ["/workspaces", "/workspaces/new", "/admin", "/admin/queue"]) {
    it(`does not redirect ${path} to a sign-in page that is not served`, () => {
      const response = middleware(request(path));
      expect(response.headers.get("location")).toBeNull();
      expect(response.status).toBe(200);
    });
  }

  it("still marks the prefix uncacheable and unindexable", () => {
    // The route 404s, but the response is still per-request and still must not be indexed.
    const response = middleware(request("/workspaces"));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("leaves public paths alone in both modes", () => {
    const response = middleware(request("/directory"));
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});

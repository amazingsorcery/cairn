import { describe, expect, it, vi } from "vitest";

import type { SignInMode } from "@/lib/auth-mode";

/**
 * In public-only mode the signed-in routes 404 as the first thing they do, before any input,
 * query or JSX. The components are called directly, since rendering can't show that ordering.
 *
 * The guard must run synchronously in the page body: inside a `<Suspense>` child, the
 * heading streams first and the status line is already 200 when `notFound()` throws.
 *
 * Page modules are imported at top level; importing them inside a test could exceed the
 * test timeout on a cold cache.
 */

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above every import in this file. */
const PUBLIC_ONLY = vi.hoisted<SignInMode>(() => ({
  github: false,
  email: false,
  enabled: false,
  publicOnly: true,
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  // Real module; only the mode is replaced.
  ...(await importOriginal<typeof import("@/lib/env")>()),
  authProviders: PUBLIC_ONLY,
}));

/**
 * `next-auth` imports `next/server`, which doesn't resolve under Vitest. Nothing here
 * reaches a session anyway.
 */
vi.mock("next-auth", () => ({
  default: () => ({
    handlers: {},
    auth: async () => null,
    signIn: async () => undefined,
    signOut: async () => undefined,
  }),
}));

const { default: WorkspacesPage, metadata: workspacesMetadata } = await import(
  "./workspaces/page"
);
const { default: SignInPage } = await import("./signin/page");
const { default: CheckEmailPage } = await import("./signin/check-email/page");
const { default: SignInErrorPage } = await import("./signin/error/page");

/** What `notFound()` throws in Next 15. */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

const noSearchParams = Promise.resolve({});

describe("in public-only mode", () => {
  it("/workspaces 404s from the page body, before anything streams", () => {
    // Must stay synchronous; see the file header.
    expect(() => WorkspacesPage()).toThrow(NOT_FOUND);
  });

  it("/signin 404s rather than rendering an explanation nobody can act on", async () => {
    await expect(SignInPage({ searchParams: noSearchParams })).rejects.toThrow(NOT_FOUND);
  });

  it("/signin/check-email 404s", async () => {
    await expect(CheckEmailPage()).rejects.toThrow(NOT_FOUND);
  });

  it("/signin/error 404s", async () => {
    await expect(SignInErrorPage({ searchParams: noSearchParams })).rejects.toThrow(NOT_FOUND);
  });

  it("titles those pages 'Not found', so the 404 body is not served under a real heading", () => {
    expect(workspacesMetadata.title).toBe("Not found");
    expect(workspacesMetadata.robots).toEqual({ index: false, follow: false });
  });
});

import { describe, expect, it, vi } from "vitest";

import type { SignInMode } from "@/lib/auth-mode";

/**
 * The signed-in routes are ABSENT in public-only mode, not redirected and not broken.
 *
 * These call the route components directly rather than rendering them. What is under test is
 * the FIRST THING each one does — a `notFound()` before any input is read, any query runs or
 * any JSX is returned — and that is a property of the function, not of the markup.
 *
 * ## The regression this file exists for
 *
 * `/workspaces` returned **HTTP 200** with a not-found body. Its guard lived in
 * `requireSession`, which is called inside the page's own `<Suspense>` child; the heading
 * streams first, so the status line is already sent when `notFound()` throws and it can only
 * swap the body. That is QA finding I-15's mechanism one layer in, and a browser hitting the
 * URL showed "Your cases" and then a 404. The fix is `requireSignInEnabled()` in the page
 * body, synchronously, before any JSX — and a test that renders the page cannot see the
 * difference, so this one calls it instead.
 *
 * The page modules are imported STATICALLY. They pull in the database client, the Auth.js
 * config and a component tree, which on a cold cache took longer than a test's own timeout
 * when the suite ran in parallel — a flake that says nothing about the product. Collection
 * has no such deadline.
 */

/** `vi.hoisted`, because `vi.mock`'s factory is lifted above every import in this file. */
const PUBLIC_ONLY = vi.hoisted<SignInMode>(() => ({
  github: false,
  email: false,
  enabled: false,
  publicOnly: true,
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  // The real module, so `env` is the parsed test environment and everything that reads it —
  // `pageMetadata`, the logger, the db client — behaves normally. Only the mode is replaced.
  ...(await importOriginal<typeof import("@/lib/env")>()),
  authProviders: PUBLIC_ONLY,
}));

/**
 * `next-auth` is stubbed for the same reason `lib/actions/workspaces.authorisation.test.ts`
 * stubs it: its runtime entry imports `next/server`, which does not resolve under Vitest's
 * SSR resolution. Nothing here reaches a session anyway — every assertion is about the guard
 * that runs BEFORE the session is looked up, which is the ordering under test.
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
    // Synchronous by design — see the file header. If this becomes an async component the
    // status regression comes back, and this line is what will say so.
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

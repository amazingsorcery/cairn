import type { BrowserContext } from "@playwright/test";

/**
 * Signed-in sessions for the E2E suite. No sign-in provider is configured locally, so the
 * suite sets session cookies for rows from `tests/e2e/helpers/seed-sessions.sql` (applied
 * manually). The magic-link and OAuth flows themselves are not covered here.
 */

export const SESSION_TOKENS = {
  /** `user` role. Owns the cases the vertical slice creates. */
  owner: "dev-owner-session-token-000000000001",
  /** `user` role, a different person. The 404-not-403 assertion needs a second account. */
  other: "dev-other-session-token-000000000002",
  /** `editor` role — `/admin` and `/admin/queue`, but not connectors or taxonomy. */
  editor: "dev-editor-session-token-00000000003",
  /** `admin` role — everything under `/admin`. */
  admin: "dev-admin-session-token-000000000004",
} as const;

export type SessionName = keyof typeof SESSION_TOKENS;

/** Attach a session cookie. Unprefixed name because the test server is plain http. */
export async function signIn(
  context: BrowserContext,
  session: SessionName,
  baseURL: string,
): Promise<void> {
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: SESSION_TOKENS[session],
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

import type { BrowserContext } from "@playwright/test";

/**
 * Signed-in sessions for the E2E suite.
 *
 * **Neither SMTP nor GitHub OAuth is configured locally**, so `authProviders.email` is
 * `false` and there is no sign-in path a browser can drive (`docs/frontend/HANDOFF-workspaces.md`
 * §9). Rather than pretend otherwise, the suite adopts the session rows that handoff §10
 * defines and sets the cookie directly. `docs/qa/e2e.md` records this as a gap: the
 * magic-link send path, its rate limit, the address cookie and the OAuth handshake are all
 * **untested**, and no spec here should be read as covering them.
 *
 * The rows are created by `tests/e2e/helpers/seed-sessions.sql` (applied by the reader, not
 * by the suite — the suite must not write to the database it is asserting against).
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

/**
 * Attach a session cookie to a context.
 *
 * The unprefixed `authjs.session-token` is the name Auth.js v5 uses over plain http, which is
 * what the local dev server and the Playwright `webServer` both are. Behind Caddy the
 * `__Secure-` prefix applies instead; `middleware.ts` checks for both.
 */
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

import { expect, test } from "@playwright/test";

import { SESSION_TOKENS, signIn, type SessionName } from "./helpers/session";

/**
 * Fixture preconditions.
 *
 * THIS FILE EXISTS BECAUSE THE SUITE ONCE FAILED FOR THE WRONG REASON. The database is shared
 * with the rest of the build, and a re-seed dropped the `editor` and `admin` rows out from
 * under a run. What came back was `authorisation.spec.ts` reporting that **an editor cannot
 * reach `/admin/queue`** — which reads as a serious authorisation regression and is not one.
 * Half an hour of the wrong investigation is a worse outcome than a red build.
 *
 * So the fixtures are asserted, once, with an actionable message. A missing account now
 * produces one clear failure that names the file to run, instead of a scatter of confusing
 * ones elsewhere. The suite still does not *create* these rows: a test suite that repairs its
 * own fixtures cannot tell you that the fixtures are wrong.
 */

/**
 * Each session, and a route only that role may see. `/workspaces` needs any session at all;
 * `/admin/queue` needs `editor` or better; `/admin/connectors` needs `admin`.
 */
const PROBES: { session: SessionName; path: string; role: string }[] = [
  { session: "owner", path: "/workspaces", role: "user" },
  { session: "other", path: "/workspaces", role: "user" },
  { session: "editor", path: "/admin/queue", role: "editor" },
  { session: "admin", path: "/admin/connectors", role: "admin" },
];

test.describe("session fixtures", () => {
  test.skip(({ isMobile }) => isMobile === true, "a fixture check does not need two viewports");

  for (const { session, path, role } of PROBES) {
    /**
     * DEFECT THIS CATCHES: a missing or expired fixture row, reported as itself rather than
     * as a false authorisation regression somewhere else in the suite.
     */
    test(`the ${session} session resolves to a ${role} who can reach ${path}`, async ({
      browser,
      baseURL,
    }) => {
      const context = await browser.newContext({ baseURL });
      await signIn(context, session, baseURL!);
      const page = await context.newPage();

      const response = await page.goto(path);
      const status = response?.status() ?? 0;

      const diagnosis =
        status === 404
          ? `the ${session} session resolved to no user, or to one without the ${role} role`
          : `the ${session} session was not recognised at all (redirected to sign-in)`;

      expect(
        status,
        `${diagnosis}. Fixture row missing or expired — re-apply it:\n` +
          `  psql "$DATABASE_URL" -f tests/e2e/helpers/seed-sessions.sql\n` +
          `  (token: ${SESSION_TOKENS[session]})`,
      ).toBe(200);

      await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/not found/i);

      await context.close();
    });
  }
});

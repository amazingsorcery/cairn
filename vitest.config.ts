import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

import { resolveTestDatabase } from "./tests/db/provision";

/**
 * The database the DB-backed suites write to, derived from `.env.local` or CI's
 * `DATABASE_URL` and suffixed `_vitest` so it is never the seeded development database and
 * never CI's `app_test`. `tests/global-setup.ts` creates and migrates it with the same
 * resolution, and `tests/db/url.ts` explains why it is derived rather than configured.
 *
 * When nothing is configured this stays the obviously-fake value it has always been: modules
 * that import `lib/db` still parse and construct a pool, and `pg` opens no socket until
 * something queries. The DB-backed suites then skip — and fail loudly in CI rather than
 * skipping there, see `tests/db/harness.ts`.
 */
const testDatabase = resolveTestDatabase();

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    // Modules that touch lib/env parse process.env at import time and throw on a bad
    // environment. That is deliberate in production; here we give the suite a valid
    // fake environment so those modules are importable. Values are obviously not real.
    env: {
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      AUTH_SECRET: "test-secret-not-real-0123456789abcdef",
      RATE_LIMIT_SECRET: "test-rate-limit-secret-not-real-0123456789",
      DATABASE_URL: testDatabase?.url ?? "postgresql://test:test@localhost:5432/test",
      LOG_LEVEL: "silent",
    },
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      /**
       * `app/**` IS INCLUDED, and it was not before.
       *
       * Excluding it hid two things that matter. The first is the route handlers and the
       * server-side helpers under `app/` — `app/workspaces/[id]/export/` renders a whole case
       * file and is the highest-leak read in the product; its authorisation check was
       * invisible to every coverage number anyone looked at. The second is that
       * `app/workspaces/[id]/export/document.test.ts` has been running all along and its
       * coverage was being discarded, so the suite was quietly worth more than the dashboard
       * said (QA finding QV-16, on the register's summary reading better than the file).
       *
       * The cost is that RSC pages and layouts, which Vitest cannot render and Playwright
       * covers instead, now appear at 0%. That is honest: they are uncovered *here*. It
       * cannot drag a passing build to failing, because the thresholds below are per
       * directory rather than global — averaging a security-critical file against a date
       * formatter is the reporting failure that produced QV-16 in the first place.
       */
      include: ["app/**", "lib/**", "components/**", "config/**", "db/**"],
      exclude: ["db/migrations/**", "**/*.test.*", "**/*.d.ts"],
      /**
       * A FLOOR ON THE TWO DIRECTORIES THAT DECIDE WHO MAY READ WHOSE CASE FILE.
       *
       * Set just under what the suite achieves today, so an ordinary refactor does not trip
       * it and deleting an authorisation test does. Numbers are per-glob, never global.
       *
       * If one of these is ever failing, the fix is a test. Lowering the number to make the
       * run pass is how `lib/actions` reached 0.14% with 85.71% branch coverage printed
       * beside it.
       */
      thresholds: {
        /*
         * THE THREE FILES THAT DECIDE WHO MAY READ WHOSE CASE FILE. Each number is a point or
         * two under what the suite measured on the commit that introduced it.
         */
        "lib/actions/workspaces.ts": {
          statements: 97,
          // The residue is the `throw error` that re-raises anything that is not
          // `FeatureAlreadySaved` out of `addWorkspaceItem`'s catch. Reaching it needs a
          // genuine driver failure mid-transaction, which no test should manufacture by
          // corrupting the schema.
          branches: 78,
          functions: 95,
          lines: 97,
        },
        "lib/queries/workspaces.ts": {
          statements: 98,
          /*
           * 65 rather than 90, deliberately, and this is the one number worth explaining.
           * The uncovered branches are the `?? ""` and `?? "infrastructure"` fallbacks in the
           * saved-feature mapping. Every one of those columns is NOT NULL and the rows are
           * already filtered on `source_slug is not null`, so the fallback cannot be reached
           * from any state the database permits. Raising this would mean either deleting
           * defensive code that costs nothing, or writing a test that corrupts the schema to
           * reach it. Neither is worth a percentage point.
           */
          branches: 65,
          functions: 95,
          lines: 98,
        },
        // Brackets are glob character classes, so the route segment is escaped. Without the
        // backslashes this key silently matches nothing and the threshold is not enforced.
        "app/workspaces/\[id\]/export/route.ts": {
          statements: 92,
          branches: 88,
          functions: 95,
          lines: 92,
        },

        /*
         * DIRECTORY RATCHETS, set at what these directories actually measure — which is low,
         * and saying so is the point.
         *
         * QV-16 was scoped to workspaces. `lib/actions/{playbooks,tools,taxonomy,connectors}.ts`
         * and most of `lib/queries` are still uncovered by unit tests and are exercised only
         * through Playwright. These numbers are not a target and must not be read as one; they
         * exist so that adding a new untested module to either directory pushes the average
         * down and fails the run, rather than passing unnoticed as `workspaces.ts` did at
         * 0.14%. They go UP as those files get tests. They never come down to make a run pass.
         */
        "lib/actions/**": { statements: 26, branches: 78, functions: 68, lines: 26 },
        "lib/queries/**": { statements: 18, branches: 58, functions: 36, lines: 18 },
      },
    },
  },
});

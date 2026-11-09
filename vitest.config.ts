import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

import { resolveTestDatabase } from "./tests/db/provision";

/**
 * Test database: `DATABASE_URL` (or `.env.local`) with a `_vitest` suffix, so it never hits
 * the dev or CI database. Created by `tests/global-setup.ts`. Without one, a fake URL is used
 * (pg connects lazily) and DB suites skip locally, fail in CI.
 */
const testDatabase = resolveTestDatabase();

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    // lib/env validates at import time; give it a valid fake environment.
    env: {
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      AUTH_SECRET: "test-secret-not-real-0123456789abcdef",
      RATE_LIMIT_SECRET: "test-rate-limit-secret-not-real-0123456789",
      DATABASE_URL: testDatabase?.url ?? "postgresql://test:test@localhost:5432/test",
      LOG_LEVEL: "silent",
      /*
       * Sign-in enabled by default; in public-only mode the workspace handlers would 404 and
       * the auth tests would assert nothing. Public-only tests override these
       * (`middleware.test.ts`, `lib/session-surface.test.ts`).
       */
      AUTH_GITHUB_ID: "test-github-client-id-not-real",
      AUTH_GITHUB_SECRET: "test-github-client-secret-not-real",
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
       * Includes `app/**` for route handlers such as the case-file export. RSC pages show 0%
       * (Playwright covers them); thresholds are per file/directory, so that doesn't fail runs.
       */
      include: ["app/**", "lib/**", "components/**", "config/**", "db/**"],
      exclude: ["db/migrations/**", "**/*.test.*", "**/*.d.ts"],
      /**
       * Per-glob floors, set just under current coverage. If one fails, add a test rather
       * than lowering the number.
       */
      thresholds: {
        // Workspace access-control files.
        "lib/actions/workspaces.ts": {
          statements: 97,
          // Uncovered: the rethrow of non-FeatureAlreadySaved errors, which needs a real
          // driver failure mid-transaction.
          branches: 78,
          functions: 95,
          lines: 97,
        },
        "lib/queries/workspaces.ts": {
          statements: 98,
          // Uncovered: `??` fallbacks on NOT NULL columns in the saved-feature mapping,
          // unreachable without corrupting the schema.
          branches: 65,
          functions: 95,
          lines: 98,
        },
        // Brackets escaped: unescaped they're a glob class and silently match nothing.
        "app/workspaces/\[id\]/export/route.ts": {
          statements: 92,
          branches: 88,
          functions: 95,
          lines: 92,
        },

        /*
         * Directory ratchets at current (low) coverage; most of these files are only covered
         * by Playwright. A new untested module will fail the run. Raise these, never lower.
         */
        "lib/actions/**": { statements: 26, branches: 78, functions: 68, lines: 26 },
        "lib/queries/**": { statements: 18, branches: 58, functions: 36, lines: 18 },
      },
    },
  },
});

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

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
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      LOG_LEVEL: "silent",
    },
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "tests/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**", "components/**", "config/**", "db/**"],
      exclude: ["db/migrations/**", "**/*.test.*"],
    },
  },
});

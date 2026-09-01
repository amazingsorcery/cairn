import type { TestProject } from "vitest/node";

import { provisionTestDatabase } from "./db/provision";

/**
 * Runs once, in Vitest's main process, before any test worker forks.
 *
 * Creating the isolated database and applying migrations here rather than in a `beforeAll`
 * is what makes parallel workers safe: forty test files calling `CREATE DATABASE` and
 * `drizzle migrate` at the same moment race on both.
 *
 * The result is `provide`d rather than thrown, so a machine with no Postgres running still
 * gets the non-database half of the suite. `tests/db/harness.ts` decides what to do with an
 * unavailable database — and in CI it fails the run.
 */
export default async function setup(project: TestProject): Promise<void> {
  project.provide("postgres", await provisionTestDatabase());
}

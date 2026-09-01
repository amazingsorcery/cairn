import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import {
  adminDatabaseUrlFrom,
  safeDatabaseName,
  TEST_DATABASE_SUFFIX,
  testDatabaseUrlFrom,
} from "./url";

/**
 * Creates and migrates the isolated database the unit suite writes to.
 *
 * WHY THIS EXISTS AT ALL. `lib/actions/workspaces.ts` and `lib/queries/workspaces.ts` are the
 * code that decides who may read whose case file, and both stood at 0% statement coverage
 * (QA finding QV-16). The properties that matter there — a non-owner gets 404 rather than
 * 403, ownership is a SQL predicate against the session user rather than a form field — are
 * properties of what Postgres actually returns. A mocked `db` would let a query that ignores
 * its `userId` parameter pass, which is the exact defect being hunted. So the tests run
 * against a real PostgreSQL and this file is what gives them one.
 *
 * It runs ONCE, in Vitest's `globalSetup`, before any worker forks. Creating the database and
 * applying migrations from inside the test files would race across parallel workers.
 */

export type PostgresAvailability =
  | { readonly available: true; readonly url: string }
  | { readonly available: false; readonly reason: string };

declare module "vitest" {
  interface ProvidedContext {
    /** Whether the DB-backed suites have a database, and why not when they do not. */
    postgres: PostgresAvailability;
  }
}

/**
 * One key from the developer's `.env.local`, or `.env`, without pulling in a dependency.
 *
 * `vite`'s `loadEnv` would do this, but `vite` is not a direct dependency of this package and
 * pnpm's strict node_modules layout correctly refuses to resolve it. `dotenv` is not a
 * dependency either, and adding one to read one variable in a test harness is not a trade
 * worth making. CI never reaches this: `DATABASE_URL` is in the job environment there.
 *
 * Deliberately minimal — `KEY=value`, `#` comments, optional surrounding quotes. It is not a
 * general `.env` parser and does not need to be.
 */
function readDotEnv(key: string): string | undefined {
  for (const file of [".env.local", ".env"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      if (trimmed.slice(0, separator).trim() !== key) continue;
      return trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return undefined;
}

/**
 * The connection strings, derived from whatever the environment already configures — the
 * developer's `.env.local` or CI's job-level `DATABASE_URL`. Called from BOTH
 * `vitest.config.ts` (which puts the result in `test.env` so `lib/env` parses it) and
 * `tests/global-setup.ts` (which creates the database). One function, so the two cannot
 * disagree about which database is under test.
 */
export function resolveTestDatabase(): { url: string; adminUrl: string } | null {
  const base = process.env.DATABASE_URL ?? readDotEnv("DATABASE_URL");

  const url = testDatabaseUrlFrom(base);
  const adminUrl = adminDatabaseUrlFrom(base);
  if (!url || !adminUrl) return null;
  return { url, adminUrl };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureDatabase(adminUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      /*
       * `CREATE DATABASE` accepts no bind parameters, so this is the one statement in the
       * repository whose identifier is interpolated as text. `safeDatabaseName` has already
       * matched it against `^[a-z_][a-z0-9_$]*$`, and the value originates in our own
       * environment rather than in a request. It is still quoted.
       */
      await client.query(`create database "${name}"`);
    }
  } catch (error) {
    // 42P04: another process created it between the SELECT and the CREATE. Not a failure.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P04") {
      return;
    }
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Clear out fixtures from PREVIOUS runs, and only previous runs.
 *
 * ## Why this is not `TRUNCATE`
 *
 * It was, for about an hour, and it produced a foreign-key violation in a passing suite:
 * `Key (playbook_id)=(…) is not present in table "playbooks"`. Two Vitest processes against
 * one database is not exotic — a `--watch` session in one terminal and `pnpm test` in
 * another is the normal way to work — and the second one's global setup truncated the first
 * one's fixtures out from under its running tests. A test harness that can fail an unrelated,
 * correct test run is worse than a slightly larger test database.
 *
 * Age is the discriminator, because it is the one property a concurrent run cannot have:
 * its rows are seconds old. Anything older than a day is from a run that has long finished.
 *
 * `users` and `categories` are the two roots; everything else cascades from one of them
 * (`workspaces`, `workspace_items`, `notes` and `workspace_feature_snapshots` from `users`;
 * `tools`, `playbooks` and `playbook_steps` from `categories`). Deleting the roots is
 * therefore enough, and doing it in one statement per root keeps the FK order trivial.
 */
async function deleteStaleFixtures(url: string, name: string): Promise<void> {
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(`Refusing to delete rows in ${name}: not a ${TEST_DATABASE_SUFFIX} database`);
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    // `categories` is restricted-referenced by `tools` and `playbooks`, so those go first.
    await client.query("delete from tools where created_at < now() - interval '1 day'");
    await client.query("delete from playbooks where created_at < now() - interval '1 day'");
    await client.query("delete from categories where created_at < now() - interval '1 day'");
    await client.query("delete from users where created_at < now() - interval '1 day'");
    await client.query("delete from rate_limits where window_start < now() - interval '1 day'");
  } finally {
    await client.end();
  }
}

async function applyMigrations(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: join(process.cwd(), "db", "migrations") });
  } finally {
    await pool.end();
  }
}

/**
 * Create the database if it is missing, apply every migration, empty it. Returns an
 * unavailability *reason* rather than throwing when there is no server to talk to: a
 * developer without Postgres running should still be able to run the rest of the suite, and
 * `tests/db/harness.ts` turns the reason into a hard failure in CI so the gap can never be
 * silent where it counts.
 */
export async function provisionTestDatabase(): Promise<PostgresAvailability> {
  const resolved = resolveTestDatabase();
  if (!resolved) {
    return {
      available: false,
      reason:
        "No DATABASE_URL in the environment or .env.local, so there is no server to create a test database on.",
    };
  }

  const name = safeDatabaseName(resolved.url);

  try {
    await ensureDatabase(resolved.adminUrl, name);
    await applyMigrations(resolved.url);
    await deleteStaleFixtures(resolved.url, name);
    return { available: true, url: resolved.url };
  } catch (error) {
    return {
      available: false,
      reason: `Could not prepare ${name}: ${describeError(error)}`,
    };
  }
}

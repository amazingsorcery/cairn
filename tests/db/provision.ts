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
 * Creates and migrates the isolated database the unit suite writes to. Workspace access
 * control is tested against real Postgres because a mocked `db` would pass a query that
 * ignores its `userId`.
 *
 * Runs once in Vitest's `globalSetup`, before workers fork, to avoid racing migrations.
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
 * One key from `.env.local` or `.env`. Minimal parser (`KEY=value`, `#` comments, optional
 * quotes) to avoid depending on vite or dotenv. CI sets `DATABASE_URL` directly.
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
 * Test and admin connection strings. Shared by `vitest.config.ts` and
 * `tests/global-setup.ts` so both agree on the database under test.
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
      // CREATE DATABASE takes no bind parameters; `safeDatabaseName` already validated it.
      await client.query(`create database "${name}"`);
    }
  } catch (error) {
    // 42P04: created concurrently by another process.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P04") {
      return;
    }
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * Delete fixtures older than a day. Not TRUNCATE: a concurrent Vitest run (e.g. `--watch`
 * alongside `pnpm test`) would lose its fixtures mid-test. Deleting the roots cascades to
 * everything else.
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
 * Create the database if missing, migrate, and clear stale fixtures. Returns a reason
 * instead of throwing when Postgres is unavailable; `tests/db/harness.ts` makes that a
 * failure in CI.
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

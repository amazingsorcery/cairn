/**
 * Where the unit suite's database lives, derived from whatever database the environment
 * already points at.
 *
 * WHY DERIVE RATHER THAN CONFIGURE A SECOND URL. The two places `pnpm test` runs are a
 * developer's machine (`.env.local` → the disposable cluster from `pnpm dev:db start`) and
 * CI (`DATABASE_URL` → the `postgres:16` service container). Both already name a reachable
 * server. Asking for a *third* variable would mean the suite silently skips wherever nobody
 * set it, and a security test that skips is worse than one that does not exist — it reports
 * green.
 *
 * WHY A SEPARATE DATABASE AND NOT THE ONE IN THE URL. These tests write users, workspaces,
 * notes and rate-limit counters, and `provision.ts` truncates before each run. Pointing that
 * at the seeded development database would destroy a developer's local catalogue, and at CI's
 * `app_test` would race the migrate/seed/build/e2e steps that follow `pnpm test` in the same
 * job. The `_vitest` suffix is the whole isolation boundary, and `provision.ts` refuses to
 * touch any database whose name does not carry it.
 */

/** Appended to the configured database's name. Also the truncation guard in `provision.ts`. */
export const TEST_DATABASE_SUFFIX = "_vitest";

/**
 * Postgres identifiers we are willing to build DDL from. `CREATE DATABASE` cannot bind a
 * parameter, so the name is checked against this before it is quoted into a statement — the
 * one place in this repo where an identifier reaches SQL as text rather than as a bound
 * value, and it is checked rather than trusted.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/i;

function parse(base: string | undefined): URL | null {
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    return url;
  } catch {
    return null;
  }
}

function databaseNameOf(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/**
 * The isolated database this suite may write to, or null when the environment names no
 * usable Postgres server.
 */
export function testDatabaseUrlFrom(base: string | undefined): string | null {
  const url = parse(base);
  if (!url) return null;

  const name = databaseNameOf(url);
  if (!name || !SAFE_IDENTIFIER.test(name)) return null;
  if (name.endsWith(TEST_DATABASE_SUFFIX)) return url.toString();

  url.pathname = `/${name}${TEST_DATABASE_SUFFIX}`;
  return url.toString();
}

/**
 * The same server, on the maintenance database, so `CREATE DATABASE` has somewhere to run
 * from. `postgres` exists on every cluster initdb creates, including CI's image and the
 * local `pnpm dev:db` cluster.
 */
export function adminDatabaseUrlFrom(base: string | undefined): string | null {
  const url = parse(base);
  if (!url) return null;
  url.pathname = "/postgres";
  return url.toString();
}

/** The database name inside a URL, validated as an identifier we may quote into DDL. */
export function safeDatabaseName(url: string): string {
  const parsed = parse(url);
  if (!parsed) throw new Error("Not a Postgres connection URL");
  const name = databaseNameOf(parsed);
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to use ${JSON.stringify(name)} as a Postgres identifier`);
  }
  return name;
}

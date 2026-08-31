import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/db/schema";
import { env, isBuildPhase } from "./env";

/**
 * The database client.
 *
 * One `pg.Pool` per process, wrapped by Drizzle and typed with the *whole* schema so the
 * relational API (`db.query.tools.findFirst({ with: { category: true } })`) is available
 * and type-safe. Passing the schema is what makes `db.query.*` exist at all — without it
 * only the builder API works.
 *
 * POOL SIZING — reasoned, not copied
 * ----------------------------------
 * Target deployment is a single 2 GB VPS running Postgres, Next.js and Caddy in Docker
 * Compose (product-brief §5), with Postgres capped at 768 MB and `max_connections` at the
 * Postgres default of 100 minus what the operator's own psql sessions and the backup job
 * need.
 *
 * - `max: 10` (`DATABASE_POOL_MAX`). Each Postgres backend costs roughly 5–10 MB of memory
 *   plus its share
 *   of `work_mem`, so ten idle backends is a cost we can afford and a hundred is not. Ten
 *   also comfortably exceeds this workload's real concurrency: every public page is served
 *   from the Next.js Data Cache or the Full Route Cache and reaches the database only on a
 *   cache miss, and the signed-in surface is a handful of users. A bigger pool would not
 *   make the site faster; it would let a traffic spike convert into a Postgres memory
 *   spike, which on a 2 GB box is an OOM kill of the database rather than a slow page.
 *   `DATABASE_POOL_MAX` overrides it. The only reason it exists is that the local PGlite
 *   harness (`scripts/dev-db.ts`) is single-connection and needs `DATABASE_POOL_MAX=1`;
 *   production and CI leave it unset and get the default.
 * - `min: 0` (pg's default). Connections are cheap to re-establish over the Compose bridge
 *   network and an idle web container should not hold backends open overnight.
 * - `idleTimeoutMillis: 30_000`. Return capacity to Postgres between traffic bursts.
 * - `connectionTimeoutMillis: 5_000`. A caller waiting on the pool must fail fast rather
 *   than hang: `/api/health` has a 5 s budget from the Docker HEALTHCHECK, and a request
 *   that blocks forever on a dead database is worse than one that 500s promptly.
 * - `statement_timeout: 15_000` / `idle_in_transaction_session_timeout: 30_000`. Server-side
 *   backstops. A runaway query on this box starves everything else, and an abandoned open
 *   transaction holds a backend and blocks VACUUM indefinitely.
 * - `allowExitOnIdle` is deliberately NOT set here (see `db/migrate.ts`, which ends its own
 *   pool explicitly): a long-lived web process must keep the event loop owned by the pool.
 *
 * If these numbers ever need to change, change them against a measurement — `docker stats`
 * and `SELECT count(*) FROM pg_stat_activity` — not against a hunch.
 */
const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  // `next build` forks a worker per CPU and each one imports this module, so the effective
  // connection count is DATABASE_POOL_MAX x workers. On an 8-core runner that is 80
  // connections against a Postgres default of 100 — enough to exhaust the server and fail
  // the build with an opaque ECONNRESET naming a random page, which is exactly what
  // happened here before this line existed. A build is a handful of sequential reads per
  // worker; it does not need a pool.
  max: isBuildPhase ? 2 : env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // `options` is passed through to the server as startup parameters, so these are enforced
  // by Postgres itself and survive any code path that forgets to set them.
  options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000",
};

/**
 * Next.js hot-reloads server modules in development by re-evaluating them, which without a
 * cache would create a new Pool on every edit and exhaust `max_connections` within an
 * afternoon. `globalThis` survives module re-evaluation; the process does not survive a
 * production deploy, so this costs nothing in production.
 */
type DatabaseCache = {
  pool: Pool | undefined;
  db: NodePgDatabase<typeof schema> | undefined;
};

const globalForDb = globalThis as typeof globalThis & {
  __cairnDb__?: DatabaseCache;
};

const cache: DatabaseCache = (globalForDb.__cairnDb__ ??= { pool: undefined, db: undefined });

/**
 * A pool-level error handler is mandatory: `pg` emits `error` on an idle client whose
 * connection the server closed (a Postgres restart, a Compose `restart`, an idle timeout on
 * a proxy), and an unhandled `error` event on an EventEmitter terminates the Node process.
 * The pool discards the broken client on its own; we only have to not crash.
 */
function createPool(): Pool {
  const pool = new Pool(poolConfig);
  pool.on("error", (error) => {
    // Imported lazily: `lib/logger` imports `lib/env`, and keeping the dependency edge
    // one-directional avoids a cycle if this module is ever imported from the logger.
    void import("./logger").then(({ logger }) => {
      logger.error({ err: error, scope: "db.pool" }, "Idle database client error");
    });
  });
  return pool;
}

export const pool: Pool = (cache.pool ??= createPool());

export const db: NodePgDatabase<typeof schema> = (cache.db ??= drizzle(pool, {
  schema,
  // `casing` is left at its default: `db/schema.ts` names every column explicitly, so no
  // automatic camelCase→snake_case translation should be in play. If one were, the Auth.js
  // adapter's snake_case property names (`refresh_token`) would be mangled.
}));

export { schema };

/** The transaction handle Drizzle passes to a `db.transaction(...)` callback. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the pool-backed client or an open transaction. Query helpers accept both. */
export type Db = NodePgDatabase<typeof schema> | Transaction;

/**
 * Close the pool. Called from the SIGTERM handler so a Compose `stop` or a deploy drains
 * cleanly instead of dropping in-flight queries (docs/deploy/HANDOFF.md A#11), and from
 * one-shot scripts so the process can exit.
 */
export async function closeDb(): Promise<void> {
  const current = cache.pool;
  cache.pool = undefined;
  cache.db = undefined;
  if (current) await current.end();
}

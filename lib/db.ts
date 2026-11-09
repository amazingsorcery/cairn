import { Pool, type PoolConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/db/schema";
import { env, isBuildPhase } from "./env";

/**
 * One `pg.Pool` per process, wrapped by Drizzle with the full schema so `db.query.*` works.
 *
 * Pool sizing targets a single 2 GB VPS (Postgres, Next.js, Caddy):
 * - `max: 10` (`DATABASE_POOL_MAX`): each backend costs ~5-10 MB, and public pages mostly hit
 *   the Next.js cache. Set to 1 for the single-connection PGlite harness (`scripts/dev-db.ts`).
 * - `idleTimeoutMillis: 30_000`: release idle backends between bursts.
 * - `connectionTimeoutMillis: 5_000`: fail fast; `/api/health` has a 5 s budget.
 * - `statement_timeout` / `idle_in_transaction_session_timeout`: server-side backstops.
 * - `allowExitOnIdle` is not set; the web process keeps the event loop alive.
 */
const poolConfig: PoolConfig = {
  connectionString: env.DATABASE_URL,
  // `next build` runs a worker per CPU, each with its own pool; keep it small to avoid
  // exhausting `max_connections`.
  max: isBuildPhase ? 2 : env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Sent as startup parameters, so Postgres enforces them.
  options: "-c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000",
};

/** Cached on `globalThis` so dev hot-reload doesn't create a new pool on every edit. */
type DatabaseCache = {
  pool: Pool | undefined;
  db: NodePgDatabase<typeof schema> | undefined;
};

const globalForDb = globalThis as typeof globalThis & {
  __cairnDb__?: DatabaseCache;
};

const cache: DatabaseCache = (globalForDb.__cairnDb__ ??= { pool: undefined, db: undefined });

/**
 * `pg` emits `error` when the server closes an idle client; unhandled, that kills the process.
 * The pool discards the client itself.
 */
function createPool(): Pool {
  const pool = new Pool(poolConfig);
  pool.on("error", (error) => {
    // Lazy import to avoid a cycle via `lib/logger` -> `lib/env`.
    void import("./logger").then(({ logger }) => {
      logger.error({ err: error, scope: "db.pool" }, "Idle database client error");
    });
  });
  return pool;
}

export const pool: Pool = (cache.pool ??= createPool());

export const db: NodePgDatabase<typeof schema> = (cache.db ??= drizzle(pool, {
  schema,
  // Default `casing`: columns are named explicitly, and auto-casing would mangle the Auth.js
  // adapter's snake_case properties.
}));

export { schema };

/** The transaction handle Drizzle passes to a `db.transaction(...)` callback. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the pool-backed client or an open transaction. Query helpers accept both. */
export type Db = NodePgDatabase<typeof schema> | Transaction;

/** Close the pool. Called on SIGTERM to drain cleanly, and from one-shot scripts. */
export async function closeDb(): Promise<void> {
  const current = cache.pool;
  cache.pool = undefined;
  cache.db = undefined;
  if (current) await current.end();
}

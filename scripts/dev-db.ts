/**
 * A disposable PostgreSQL for local verification. **Development only.**
 *
 * Production runs real PostgreSQL 16 in a container (docker-compose.prod.yml) and CI runs
 * the `postgres:16` service image. This exists solely so the application can actually be
 * booted and looked at on a machine with no Docker and no database credentials — because
 * shipping a build nobody has ever run is not a build, it is a hypothesis.
 *
 * PGlite runs Postgres compiled to WebAssembly in this process, and `pglite-socket` exposes
 * it on a TCP port speaking the real wire protocol. That means `pg` connects to it
 * unchanged: no driver swap, no second code path in `lib/db.ts`, nothing that could make
 * local behaviour diverge from production behaviour.
 *
 * Known divergences from the production database, which is why this verifies and never
 * certifies:
 *   - PGlite is single-connection, so it proves nothing about pooling or concurrency.
 *   - It is Postgres 17-derived; production and CI are 16.
 *   - Extension availability is narrower. If `pg_trgm` is unavailable the trigram
 *     fallback in search cannot be exercised here — CI is the gate for that.
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

const PORT = Number(process.env.DEV_DB_PORT ?? 55432);
const DATA_DIR = process.env.DEV_DB_DIR ?? ".dev-db";

async function main(): Promise<void> {
  // pg_trgm is not built in: PGlite ships contrib extensions as explicit imports. Without
  // it the trigram fallback in search (docs/architecture/search.md) could not be exercised
  // locally at all, and that fallback is the path a user hits when full-text finds nothing.
  const db = await PGlite.create({ dataDir: DATA_DIR, extensions: { pg_trgm } });

  const available = await db.query<{ name: string }>(
    "select name from pg_available_extensions where name = 'pg_trgm'",
  );
  const hasTrgm = available.rows.length > 0;

  const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  await server.start();

  console.log(`dev database listening on 127.0.0.1:${PORT} (data in ${DATA_DIR})`);
  console.log(`pg_trgm available: ${hasTrgm ? "yes" : "NO — trigram fallback is untestable here"}`);
  console.log(`DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres"`);

  const shutdown = async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("dev database failed to start:", error);
  process.exit(1);
});

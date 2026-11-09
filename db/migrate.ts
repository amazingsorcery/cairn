/**
 * Migration runner (`pnpm db:migrate`). Runs in the one-shot `migrator` container and from
 * `infra/deploy.sh`.
 *
 * - Exits non-zero on failure; deploy.sh rolls back on that.
 * - Idempotent via Drizzle's journal table, so re-running is safe.
 * - Closes the pool so the container exits.
 *
 * Hand-written migrations hold what drizzle-kit can't emit (pg_trgm, gin_trgm_ops indexes,
 * the DEFERRABLE unique on playbook_steps). Never use `drizzle-kit push`; it drops them.
 * Drizzle runs all pending migrations in one transaction.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, db } from "@/lib/db";
import { logger } from "@/lib/logger";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "migrations");

type JournalEntry = { idx: number; tag: string; when: number };

/**
 * Reads the journal so each step is logged (Drizzle logs nothing), and checks `when` is
 * strictly ascending: Drizzle compares against the highest applied timestamp, so an
 * out-of-order entry would be silently skipped.
 */
function readJournal(): JournalEntry[] {
  const raw: unknown = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  );
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("entries" in raw) ||
    !Array.isArray((raw as { entries: unknown }).entries)
  ) {
    throw new Error("db/migrations/meta/_journal.json is malformed: no `entries` array");
  }
  const entries = (raw as { entries: JournalEntry[] }).entries;

  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (!previous || !current) continue;
    if (current.when <= previous.when) {
      throw new Error(
        `Journal ordering is broken: "${current.tag}" (when=${current.when}) does not come ` +
          `after "${previous.tag}" (when=${previous.when}). Drizzle records only the highest ` +
          `applied timestamp, so an out-of-order entry is applied once and then skipped ` +
          `forever. Fix db/migrations/meta/_journal.json before deploying.`,
      );
    }
  }

  return entries;
}

async function main(): Promise<void> {
  const started = Date.now();
  const entries = readJournal();

  logger.info(
    { scope: "migrate", folder: migrationsFolder, count: entries.length },
    "Applying migrations",
  );
  for (const entry of entries) {
    logger.info({ scope: "migrate", idx: entry.idx, tag: entry.tag }, "  journal entry");
  }

  await migrate(db, { migrationsFolder });

  logger.info({ scope: "migrate", durationMs: Date.now() - started }, "Migrations up to date");
}

main()
  .then(async () => {
    // No process.exit(0): it can cut the socket before the terminate packet is flushed,
    // which wedges single-connection servers like the local PGlite harness.
    await closeDb();
  })
  .catch(async (error: unknown) => {
    logger.error({ scope: "migrate", err: error }, "Migration failed");
    // Also to stderr, in case LOG_LEVEL=silent.
    console.error(error);
    try {
      await closeDb();
    } catch {
      // Pool may never have opened.
    }
    process.exit(1);
  });

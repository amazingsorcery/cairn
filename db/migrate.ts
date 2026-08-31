/**
 * Migration runner. `pnpm db:migrate`.
 *
 * Runs in a dedicated one-shot container (Dockerfile target `migrator`) via
 * `docker compose --profile tools run --rm migrate`, and from `infra/deploy.sh` between the
 * backup and the start. docs/deploy/HANDOFF.md A#10 is the contract:
 *
 *   - exits NON-ZERO on failure. deploy.sh treats a non-zero exit as "roll back". A script
 *     that swallows its own error turns a failed migration into a successful deploy of a
 *     broken site, which is the worst outcome available here.
 *   - is IDEMPOTENT. Drizzle's journal table (`drizzle.__drizzle_migrations`) gives this for
 *     free; nothing below defeats it. Re-running with nothing to apply succeeds and does
 *     nothing, which is what makes deploy.sh safe to re-run after a partial failure.
 *   - closes the pool, so the container exits instead of hanging on an open socket.
 *
 * ORDER. The journal in `db/migrations/meta/_journal.json` is applied in array order and
 * must read: 0000_extensions -> 0001_schema (drizzle-kit generated) -> 0002_search_and_ordering.
 * The two hand-written files are the objects drizzle-kit cannot emit (HANDOFF §6): the
 * pg_trgm extension, the two gin_trgm_ops indexes, and the DEFERRABLE unique constraint on
 * playbook_steps. `drizzle-kit push` would drop all three and is forbidden everywhere.
 *
 * Drizzle applies every pending migration inside ONE transaction, so a failure part-way
 * leaves the database exactly as it was. That is why this script does not open its own.
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
 * Read the journal ourselves before handing it to Drizzle, purely so the log names each
 * step. Drizzle's migrator prints nothing, and "migrations applied" with no list is not a
 * useful line to find in a deploy log at 3am.
 *
 * It also catches the one failure mode that is otherwise silent: Drizzle decides what is
 * already applied by comparing `created_at` against the journal's `when`, and it iterates
 * the entries in array order. If a hand-written entry were inserted with a `when` out of
 * ascending order, migrations would appear to apply and then be skipped forever. Asserting
 * the ordering here turns that into a loud failure before a single statement runs.
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
    await closeDb();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ scope: "migrate", err: error }, "Migration failed");
    // Also to stderr: the migrator container's logs are what an operator reads first, and
    // a pino line at LOG_LEVEL=silent would leave them with an exit code and nothing else.
    console.error(error);
    try {
      await closeDb();
    } catch {
      // Closing a pool that never opened is not the failure worth reporting here.
    }
    process.exit(1);
  });

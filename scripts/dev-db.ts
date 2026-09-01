/**
 * Local PostgreSQL for development and verification. **Development only.**
 *
 * Production runs PostgreSQL 16 in a container (`docker-compose.prod.yml`); CI runs the
 * `postgres:16` service image. This script manages a *separate, disposable* cluster in
 * `.devpg/` using whatever PostgreSQL binaries are on PATH, so the build can actually be
 * run on a machine with no Docker — because shipping a build nobody has executed is not a
 * build, it is a hypothesis.
 *
 * It deliberately does NOT touch any existing cluster, does not need credentials for one,
 * and does not modify any system configuration. It initialises its own data directory with
 * trust authentication bound to 127.0.0.1 on a non-default port.
 *
 * Commands:
 *   pnpm dev:db start     initdb if needed, start, create the database and pg_trgm
 *   pnpm dev:db stop      stop the cluster
 *   pnpm dev:db status    is it running
 *   pnpm dev:db reset     stop, delete the data directory, start fresh
 *
 * Divergences from production, which is why this verifies and never certifies:
 *   - PostgreSQL 17 here; 16 in production and CI. CI remains the gate for planner
 *     behaviour and anything version-sensitive.
 *   - trust auth on loopback. Never use this configuration for anything reachable.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DEV_DB_DIR ?? join(process.cwd(), ".devpg");
const PORT = process.env.DEV_DB_PORT ?? "55433";
const DB_NAME = process.env.DEV_DB_NAME ?? "cairn_dev";
const LOG = join(DATA_DIR, "server.log");

const url = (db: string) => `postgresql://postgres@127.0.0.1:${PORT}/${db}`;

function run(bin: string, args: string[], allowFailure = false): string {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `${bin} could not be run. Is PostgreSQL installed and on PATH?\n${result.error.message}`,
    );
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${bin} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

function isRunning(): boolean {
  const result = spawnSync("pg_ctl", ["-D", DATA_DIR, "status"], { encoding: "utf8" });
  return result.status === 0;
}

function psql(db: string, sql: string, allowFailure = false): string {
  return run("psql", ["-w", url(db), "-tAc", sql], allowFailure);
}

function start(): void {
  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) {
    console.log(`initialising a fresh cluster in ${DATA_DIR}`);
    run("initdb", [
      "-D",
      DATA_DIR,
      "-U",
      "postgres",
      "--auth-local=trust",
      "--auth-host=trust",
      "-E",
      "UTF8",
      "--no-locale",
    ]);
  }

  if (isRunning()) {
    console.log(`already running on 127.0.0.1:${PORT}`);
  } else {
    // Modest settings: this mirrors the constrained VPS rather than the developer's laptop,
    // so a query that is only fast because of a huge cache does not look fine here.
    /*
     * Start DETACHED, with stdio fully ignored.
     *
     * `pg_ctl -w start` run through a normal spawn does not return: the postmaster inherits
     * the parent's stdout pipe and keeps it open, so the shell waits on it forever. The
     * command then gets moved to a background task — and the postmaster is now tethered to
     * that task's lifetime. When the harness reaps it, the shared database dies with it.
     *
     * That happened three times in one session. The symptom is the worst kind: no error
     * anywhere, just `not running` the next time somebody looks, and every other agent's dev
     * server failing on connection refused for reasons that appear unrelated to anything
     * they did.
     *
     * `detached` plus `stdio: "ignore"` plus `unref()` means the postmaster holds no pipe and
     * belongs to no process tree we control. Postgres already writes to `-l LOG`, so nothing
     * is lost by discarding the handles.
     */
    const child = spawn(
      "pg_ctl",
      [
        "-D",
        DATA_DIR,
        "-l",
        LOG,
        "-o",
        `-p ${PORT} -c listen_addresses=127.0.0.1 -c max_connections=50 -c shared_buffers=128MB`,
        "start",
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();

    // `pg_ctl` was told not to wait, so wait here instead: poll until it accepts a
    // connection, rather than assuming and letting the next command fail confusingly.
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline) {
      if (spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", PORT], { encoding: "utf8" }).status === 0) {
        up = true;
        break;
      }
    }
    if (!up) {
      throw new Error(`Postgres did not accept connections within 30s. See ${LOG}.`);
    }
    console.log(`started on 127.0.0.1:${PORT} (detached)`);
  }

  const exists = psql("postgres", `select 1 from pg_database where datname = '${DB_NAME}'`).trim();
  if (!exists) {
    psql("postgres", `create database ${DB_NAME}`);
    console.log(`created database ${DB_NAME}`);
  }

  // pg_trgm backs the fuzzy fallback in search. Without it the trigram indexes in
  // migration 0002 cannot be created and the fallback path is untestable.
  psql(DB_NAME, "create extension if not exists pg_trgm");

  console.log("");
  console.log(`DATABASE_URL=${url(DB_NAME)}`);
  console.log(`logs: ${LOG}`);
}

function stop(): void {
  if (!isRunning()) {
    console.log("not running");
    return;
  }
  run("pg_ctl", ["-D", DATA_DIR, "-m", "fast", "-w", "stop"]);
  console.log("stopped");
}

/**
 * Destroy and recreate the cluster.
 *
 * Wrapped in try/finally because the naive version has a sharp edge that bit us: `stop()`
 * runs first, so ANY failure between stopping and starting leaves the cluster **stopped**
 * rather than rolled back. On a machine where several agents share this database that is a
 * foot-gun — it presents to everyone else as an unrelated mystery outage, and the person who
 * hits it first has no reason to suspect a reset they did not run.
 *
 * The `finally` cannot un-delete the data directory, so it does not pretend to. What it
 * guarantees is that the process never *leaves* the cluster down: whatever happened, it ends
 * with a running server, and it says loudly if it had to recover.
 */
function reset(): void {
  let recreated = false;
  try {
    stop();
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`removed ${DATA_DIR}`);
    start();
    recreated = true;
  } finally {
    if (!recreated) {
      console.error("");
      console.error("reset did not complete. Attempting to leave a RUNNING cluster behind,");
      console.error("because a half-finished reset that stops the server looks to everyone");
      console.error("else like an unexplained outage.");
      try {
        start();
        console.error("Recovered: the cluster is running. Data may or may not have survived");
        console.error("— check with `pnpm dev:db:counts` before trusting it.");
      } catch (error) {
        console.error("Recovery FAILED. Run `pnpm dev:db start` by hand.");
        console.error(error instanceof Error ? error.message : String(error));
      }
    }
  }
}

const command = process.argv[2] ?? "start";

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    console.log(isRunning() ? `running on 127.0.0.1:${PORT}` : "not running");
    break;
  case "reset":
    reset();
    break;
  default:
    console.error(`Unknown command "${command}". Use start, stop, status or reset.`);
    process.exit(1);
}

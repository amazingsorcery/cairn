import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Liveness + readiness probe. Contract: docs/deploy/HANDOFF.md A#2.
 *
 * FOUR things consume this endpoint, which is why its behaviour is a contract rather than
 * an implementation detail:
 *
 *   1. the Dockerfile HEALTHCHECK,
 *   2. docker-compose.prod.yml's `web` healthcheck, which gates `depends_on`,
 *   3. infra/deploy.sh's verification step, which decides whether to roll back,
 *   4. playwright.config.ts's `webServer` readiness probe.
 *
 * Because of (3), a handler that returns 200 without touching the database would let
 * deploy.sh complete a deploy of a site where every page 500s. So it genuinely queries.
 *
 * The body says `ok` or `error` and nothing else. No version string, no commit SHA, no
 * environment name, no dependency list, no error text — this URL is publicly reachable at
 * https://<domain>/api/health and every one of those is reconnaissance. The reason for a
 * failure goes to the logs, where an operator can read it and an attacker cannot.
 */

/** Never prerender, never serve a stale "ok" from the Full Route Cache. */
export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Node runtime: the `pg` pool is not available on the edge runtime. */
export const runtime = "nodejs";

/**
 * Shorter than the 5 s HEALTHCHECK timeout, so the handler always answers before Docker
 * gives up on it. A probe that hangs is reported as a failure with no diagnostic; a probe
 * that returns 503 in two seconds is a failure with one.
 */
const PROBE_TIMEOUT_MS = 2_000;

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Content-Type": "application/json",
} as const;

async function probeDatabase(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database probe exceeded ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });

  try {
    // Raw `select 1` through the Drizzle sql template tag: there is no table to query and
    // nothing to bind. This is the cheapest statement that proves a backend answered,
    // which is the whole claim the endpoint makes.
    await Promise.race([db.execute(sql`select 1`), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  try {
    await probeDatabase();
    return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
      status: 200,
      headers: NO_STORE,
    });
  } catch (error) {
    logger.error({ err: error, scope: "health" }, "Health check failed");
    return new Response(JSON.stringify({ status: "error" }), {
      status: 503,
      headers: NO_STORE,
    });
  }
}

/**
 * `HEAD` is what a few probes default to. Without an explicit export Next.js answers it
 * from `GET` and discards the body, which is correct behaviour but runs the database probe
 * anyway — which is what we want here, so it is delegated rather than short-circuited.
 */
export const HEAD = GET;

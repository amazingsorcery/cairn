import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

/**
 * Liveness + readiness probe, used by the Dockerfile HEALTHCHECK, the compose healthcheck,
 * `infra/deploy.sh` (rollback decision) and Playwright's `webServer`. It queries the
 * database so a deploy where every page 500s doesn't pass.
 *
 * Public URL, so the body is only `ok`/`error`; failure details go to the logs.
 */

/** Never serve a stale "ok" from the Full Route Cache. */
export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Node runtime: the `pg` pool is not available on the edge runtime. */
export const runtime = "nodejs";

/** Under the 5 s HEALTHCHECK timeout, so we answer 503 (and log why) before Docker gives up. */
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
    // Cheapest statement that proves the database answered.
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

/** Some probes default to `HEAD`; it should run the database probe too. */
export const HEAD = GET;

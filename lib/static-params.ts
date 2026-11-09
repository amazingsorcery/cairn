import { isBuildPhase } from "./env";
import { logger } from "./logger";

/**
 * Run a `generateStaticParams` query, returning [] if the database is unreachable (e.g.
 * `docker build` has none). `dynamicParams` stays true, so those pages render on first
 * request and are cached by ISR. Catches any error on purpose.
 */
export async function staticParamsOrEmpty<T>(
  route: string,
  load: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await load();
  } catch (error) {
    logger.warn(
      { route, err: error instanceof Error ? error.message : String(error) },
      "generateStaticParams could not reach the database; this route will be generated on " +
        "demand at runtime instead of prerendered. Expected during a build with no database.",
    );
    return [];
  }
}

/**
 * Database read for a prerendered (`revalidate`) page: returns `fallback` during `next build`
 * if the read fails, rethrows at runtime so `error.tsx` and the health check see it.
 */
export async function buildSafe<T>(scope: string, load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isBuildPhase) throw error;
    logger.warn(
      { scope, err: error instanceof Error ? error.message : String(error) },
      "Prerender read failed during the build with no database; using the empty fallback. " +
        "The page will be generated on demand at runtime.",
    );
    return fallback;
  }
}

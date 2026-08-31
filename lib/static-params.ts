import { isBuildPhase } from "./env";
import { logger } from "./logger";

/**
 * Run a `generateStaticParams` query that needs the database, tolerating its absence.
 *
 * `docker build` has no database, and should not — a build that needs a live production
 * database is not reproducible and cannot run on a clean CI runner. Without this, four
 * routes fail the production build outright. See ADR 0018.
 *
 * Nothing is silently dropped. `dynamicParams` stays at its default of `true`, so:
 *   - with a database at build time, pages are prerendered exactly as intended;
 *   - without one, they render on first request and are then cached by ISR.
 *
 * The cost of the second case is one cold render per page, once. The cost of not doing this
 * is that the image cannot be built at all.
 *
 * Deliberately catches broadly: the point is that ANY failure to reach the database during
 * a build is survivable, whether that is a refused connection, a DNS failure, a missing
 * table on a fresh volume, or a placeholder `DATABASE_URL`. At runtime this helper is not
 * on the path — a page that cannot read the database throws, and `error.tsx` handles it.
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
 * Run a database read that a prerendered page needs, tolerating the build having no
 * database — and ONLY the build.
 *
 * `docker build` carries no `DATABASE_URL` by design (ADR 0018), so any ISR page that reads
 * the database fails at the export step. The fix is not to swallow errors: at runtime a page
 * that cannot reach the database SHOULD fail, so `error.tsx` renders and the health check
 * notices. This helper draws that line precisely — it substitutes a fallback during
 * `next build` and rethrows everywhere else.
 *
 * Use it for a page that is prerendered (has `revalidate`) and reads the database. A
 * `force-dynamic` page never prerenders and does not need it.
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

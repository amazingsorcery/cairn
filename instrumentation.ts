/**
 * Next's startup hook. `register()` runs once when the server process starts — in `next dev`,
 * in `next start`, and in the standalone server the Docker image runs — and never during
 * `next build`.
 *
 * IT EXISTS FOR ONE LINE. A deployment with no GitHub OAuth and no SMTP serves the whole
 * public product and no signed-in surface, and the operator has to be told that at boot,
 * because every symptom of it looks like a bug: no sign-in button, `/workspaces` returning
 * 404, an account they cannot create. Before this, the same configuration refused to boot at
 * all with a message about sign-in, which was louder and wrong. See ADR 0032.
 *
 * Nothing else belongs here. It is not a place for warm-up queries, cache priming or
 * migrations: this runs before the first request on a box with 2 GB of RAM, and a slow
 * `register()` is a slow deploy with no health check to fail against.
 */
export async function register(): Promise<void> {
  /*
   * Node only. Next also evaluates this file for the Edge runtime, where `pino` and the
   * Postgres client do not exist — importing `lib/logger` there would throw at boot, which
   * is a spectacular failure for a file whose whole job is a log line.
   *
   * The imports are dynamic for the same reason: a static import would be resolved for both
   * runtimes regardless of the branch.
   */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { PUBLIC_ONLY_NOTICE, SIGN_IN_ENABLED_NOTICE } = await import("@/lib/auth-mode");
  const { authProviders } = await import("@/lib/env");
  const { logger } = await import("@/lib/logger");

  if (authProviders.publicOnly) {
    logger.info({ scope: "boot", mode: "public-only" }, PUBLIC_ONLY_NOTICE);
    return;
  }

  logger.info(
    {
      scope: "boot",
      mode: "sign-in",
      // Which providers, never their configuration. The values are secrets and the redaction
      // list in `lib/logger.ts` is a safety net, not a licence to log near them.
      providers: [authProviders.github ? "github" : null, authProviders.email ? "email" : null]
        .filter((name): name is string => name !== null)
        .join(","),
    },
    SIGN_IN_ENABLED_NOTICE,
  );
}

/**
 * Next's startup hook; runs once at server start, never during `next build`.
 *
 * Logs the sign-in mode at boot, since public-only mode (no sign-in button, `/workspaces`
 * 404s) otherwise looks like a bug. Keep it fast; no warm-up queries or migrations here.
 */
export async function register(): Promise<void> {
  // Node only: pino and pg don't exist on Edge. Dynamic imports so Edge never resolves them.
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
      // Provider names only, never their (secret) configuration.
      providers: [authProviders.github ? "github" : null, authProviders.email ? "email" : null]
        .filter((name): name is string => name !== null)
        .join(","),
    },
    SIGN_IN_ENABLED_NOTICE,
  );
}

import { deriveSignInMode, type SignInMode } from "./auth-mode";
import { parseEnv, type EnvPhase, type ServerEnv } from "./env.schema";

/**
 * Eagerly validated environment: importing this throws on bad config, so the container fails
 * at boot. Server-only.
 *
 * `docker build` carries no secrets but Next still imports route modules during the build, so
 * the build phase is lenient. `NEXT_PHASE` is only `phase-production-build` during `next build`.
 */
const phase: EnvPhase =
  process.env.NEXT_PHASE === "phase-production-build" ? "build" : "runtime";

export const env: ServerEnv = parseEnv(process.env, phase);

/** True while compiling. Used by `generateStaticParams` to tolerate an absent database. */
export const isBuildPhase = phase === "build";

export type { ServerEnv };

/**
 * Usable sign-in methods for this configuration. Same derivation `middleware.ts` uses in the
 * Edge runtime.
 */
export const authProviders: SignInMode = deriveSignInMode({
  AUTH_GITHUB_ID: env.AUTH_GITHUB_ID,
  AUTH_GITHUB_SECRET: env.AUTH_GITHUB_SECRET,
  SMTP_HOST: env.SMTP_HOST,
  SMTP_FROM: env.SMTP_FROM,
});

/** Emails granted the admin role on first sign-in. Lower-cased and de-duplicated. */
export const adminEmails: readonly string[] = Array.from(
  new Set(
    env.ADMIN_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
);

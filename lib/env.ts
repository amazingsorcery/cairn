import { parseEnv, type EnvPhase, type ServerEnv } from "./env.schema";

/**
 * Eagerly validated environment.
 *
 * Importing this module parses `process.env` and throws if anything is wrong, so a
 * misconfigured container fails at boot rather than serving 500s later. The schema itself
 * lives in `env.schema.ts` so it can be unit-tested without a real environment.
 *
 * Server-only. Never import this from a Client Component.
 *
 * The phase distinction exists because `docker build` deliberately carries no secrets
 * (an ARG is visible in `docker history`) while Next imports every route module — and so
 * this one — to collect page data. Without it, `docker build` cannot succeed. Next sets
 * `NEXT_PHASE` to `phase-production-build` only during `next build`, never during
 * `next start`, so the strict path is the one that actually serves traffic. See ADR 0018.
 */
const phase: EnvPhase =
  process.env.NEXT_PHASE === "phase-production-build" ? "build" : "runtime";

export const env: ServerEnv = parseEnv(process.env, phase);

/** True while compiling. Used by `generateStaticParams` to tolerate an absent database. */
export const isBuildPhase = phase === "build";

export type { ServerEnv };

/** Which sign-in methods are actually usable with the current configuration. */
export const authProviders = {
  github: Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET),
  email: Boolean(env.SMTP_HOST && env.SMTP_FROM),
} as const;

/** Emails granted the admin role on first sign-in. Lower-cased and de-duplicated. */
export const adminEmails: readonly string[] = Array.from(
  new Set(
    env.ADMIN_EMAILS.split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),
);

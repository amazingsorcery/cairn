import { parseEnv, type ServerEnv } from "./env.schema";

/**
 * Eagerly validated environment.
 *
 * Importing this module parses `process.env` and throws if anything is wrong, so a
 * misconfigured container fails at boot rather than serving 500s later. The schema itself
 * lives in `env.schema.ts` so it can be unit-tested without a real environment.
 *
 * Server-only. Never import this from a Client Component.
 */
export const env: ServerEnv = parseEnv(process.env);

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

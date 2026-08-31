import { z } from "zod";

/**
 * Environment contract.
 *
 * Parsed once, at module load, on the server only. If the environment is wrong the
 * process refuses to boot rather than failing later inside a request handler — a
 * misconfigured container should fail loudly at `docker compose up`, not silently serve
 * 500s at 3am. See docs/deploy/RUNBOOK.md and .env.example.
 */

const nonEmpty = (label: string) => z.string().min(1, `${label} must not be empty`);

const serverSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /** Canonical public origin. Used for magic-link callbacks, metadata and sitemaps. */
    APP_URL: z.string().url("APP_URL must be an absolute URL, e.g. https://example.com"),

    /** Auth.js session/JWT signing key. Generate with: openssl rand -base64 32 */
    AUTH_SECRET: nonEmpty("AUTH_SECRET").min(
      32,
      "AUTH_SECRET must be at least 32 characters — generate with: openssl rand -base64 32",
    ),

    /**
     * HMAC key for rate-limit and audit-log subject hashing. Never a raw email or IP
     * reaches the database (ADR 0009, ADR 0013). Generate with: openssl rand -hex 32
     *
     * Rotating it resets every rate-limit window and breaks audit-log correlation across
     * the rotation. Both are acceptable: windows are minutes long and audit retention is
     * 30 days. It must NOT be the same value as AUTH_SECRET — one is a session-forgery key
     * and the other is a pseudonymisation key, and they have different blast radii.
     */
    RATE_LIMIT_SECRET: nonEmpty("RATE_LIMIT_SECRET").min(
      32,
      "RATE_LIMIT_SECRET must be at least 32 characters — generate with: openssl rand -hex 32",
    ),

    /** Required when running behind Caddy so Auth.js honours x-forwarded-* headers. */
    AUTH_TRUST_HOST: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),

    DATABASE_URL: z
      .string()
      .url("DATABASE_URL must be a postgres:// or postgresql:// URL")
      .refine(
        (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
        "DATABASE_URL must use the postgres:// or postgresql:// scheme",
      ),

    /**
     * Maximum pooled database connections. Optional, with a default sized for the target
     * deployment (see lib/db.ts). It exists as a knob because the local PGlite harness is
     * single-connection and needs `DATABASE_POOL_MAX=1`; production is left alone.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /** GitHub OAuth. Both or neither — a half-configured provider is a broken button. */
    AUTH_GITHUB_ID: z.string().optional(),
    AUTH_GITHUB_SECRET: z.string().optional(),

    /** SMTP for the email magic link. All five or none. */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().email("SMTP_FROM must be an email address").optional(),

    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),

    /** Comma-separated user emails granted the admin role on first sign-in. */
    ADMIN_EMAILS: z.string().default(""),
  })
  .superRefine((env, ctx) => {
    if (env.RATE_LIMIT_SECRET === env.AUTH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RATE_LIMIT_SECRET"],
        message:
          "RATE_LIMIT_SECRET must not be the same value as AUTH_SECRET. Generate a separate one with: openssl rand -hex 32",
      });
    }

    const github = [env.AUTH_GITHUB_ID, env.AUTH_GITHUB_SECRET];
    if (github.some(Boolean) && !github.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_GITHUB_ID"],
        message:
          "GitHub OAuth is half-configured. Set both AUTH_GITHUB_ID and AUTH_GITHUB_SECRET, or neither.",
      });
    }

    const smtp = [env.SMTP_HOST, env.SMTP_PORT, env.SMTP_USER, env.SMTP_PASSWORD, env.SMTP_FROM];
    if (smtp.some((v) => v !== undefined) && !smtp.every((v) => v !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SMTP_HOST"],
        message:
          "SMTP is half-configured. Set all of SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM, or none.",
      });
    }

    const hasGithub = github.every(Boolean);
    const hasSmtp = smtp.every((v) => v !== undefined);
    if (env.NODE_ENV === "production" && !hasGithub && !hasSmtp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SECRET"],
        message:
          "No sign-in method is configured. Production needs GitHub OAuth, SMTP magic link, or both — otherwise nobody can log in.",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * Which phase we are validating for. See ADR 0018.
 *
 * `runtime` is strict and throwing: a misconfigured container must fail at `docker compose
 * up`, not serve 500s at 3am.
 *
 * `build` exists because `docker build` deliberately carries no secrets — an ARG is visible
 * in `docker history` — while Next imports every route module (and therefore this one) to
 * collect page data. The shape rules below still apply to anything that IS present; what is
 * relaxed is the requirement that secrets exist at all, and the cross-field production
 * checks, which ask "can a user log into this deployment?" — a question about a running
 * server, not about a compiled artefact.
 */
export type EnvPhase = "runtime" | "build";

/**
 * Placeholders used only while compiling. They are never reachable at runtime: the strict
 * path is selected unless `NEXT_PHASE` says a production build is in progress, and Next
 * never sets that during `next start`. They are deliberately self-describing so that if one
 * ever DID surface in a log or an error, it would be unmistakable rather than plausible.
 */
const BUILD_PLACEHOLDERS: Readonly<Record<string, string>> = {
  APP_URL: "http://build.invalid",
  AUTH_SECRET: "build-phase-placeholder-not-a-secret-0000",
  RATE_LIMIT_SECRET: "build-phase-placeholder-not-a-secret-1111",
  DATABASE_URL: "postgresql://build:build@build.invalid:5432/build",
};

/** Exported for unit tests so the validation rules can be exercised without a real env. */
export function parseEnv(source: NodeJS.ProcessEnv, phase: EnvPhase = "runtime"): ServerEnv {
  const candidate: NodeJS.ProcessEnv =
    phase === "build"
      ? {
          ...source,
          // Only fill what is ABSENT. A real value supplied at build time is still validated
          // and still used, so a build with a database prerenders exactly as intended.
          ...Object.fromEntries(
            Object.entries(BUILD_PLACEHOLDERS).filter(([key]) => !source[key]),
          ),
          // The cross-field check "production needs a sign-in method" is about a running
          // server. Presenting the build as non-production skips it without weakening
          // anything that runs.
          NODE_ENV: "development",
        }
      : source;

  const parsed = serverSchema.safeParse(candidate);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\nSee .env.example for every variable and how to generate the secrets.`,
    );
  }

  return parsed.data;
}

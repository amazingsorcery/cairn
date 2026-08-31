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

/** Exported for unit tests so the validation rules can be exercised without a real env. */
export function parseEnv(source: NodeJS.ProcessEnv): ServerEnv {
  const parsed = serverSchema.safeParse(source);

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

import { z } from "zod";

/**
 * Environment contract. Parsed once at module load (server only); a bad environment fails
 * at boot. See .env.example.
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
     * HMAC key for hashing rate-limit and audit-log subjects, so no raw email or IP is
     * stored. Generate with: openssl rand -hex 32. Rotating resets rate-limit windows and
     * audit correlation. Must differ from AUTH_SECRET.
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

    /** Max pooled connections (see lib/db.ts). The PGlite harness needs 1. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /** GitHub OAuth. Both or neither. */
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

    /* ---------------------------------------------------------------- *
     * Live sources. All optional: a missing key disables one layer.
     * ---------------------------------------------------------------- */

    /** NASA FIRMS wildfire hotspots. Register at firms.modaps.eosdis.nasa.gov. */
    FIRMS_MAP_KEY: z.string().optional(),

    /**
     * Socrata app token for the US municipal 911 feeds. Not an `apiKeyEnvVar`: it only raises
     * the anonymous throttle, so layers still work without it.
     * Free: https://dev.socrata.com/docs/app-tokens.html
     */
    SOCRATA_APP_TOKEN: z.string().optional(),
    /** Which FIRMS satellite product to read, e.g. VIIRS_SNPP_NRT. */
    FIRMS_SOURCE: z.string().optional(),
    /** Override the USGS earthquake feed window, e.g. all_hour, all_day. */
    USGS_QUAKE_FEED: z.string().optional(),
    /** Default aircraft viewport as "lat,lon,radiusNm". */
    AIRCRAFT_VIEWPORT: z.string().optional(),
    /** Contact address for the User-Agent; NWS and Nominatim ask for one. */
    SOURCE_CONTACT_EMAIL: z.string().email().optional(),

    // No REDIS_URL: the source cache is in-process and nothing would read it.
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

    // No sign-in provider at all is allowed (public-only mode, see `lib/auth-mode.ts`);
    // only half-configured providers are rejected.
  });

export type ServerEnv = z.infer<typeof serverSchema>;

/**
 * `runtime` is strict. `build` fills absent secrets with placeholders, since `docker build`
 * carries none but Next imports this module. Values that are present are still validated,
 * including the half-configured provider checks.
 */
export type EnvPhase = "runtime" | "build";

/** Build-only placeholders, obviously fake so they're recognisable if they ever leak. */
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
          // Only fill absent keys; real values are still validated and used.
          ...Object.fromEntries(
            Object.entries(BUILD_PLACEHOLDERS).filter(([key]) => !source[key]),
          ),
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

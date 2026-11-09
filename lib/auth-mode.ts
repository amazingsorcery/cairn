/**
 * Which sign-in methods this deployment has. No imports so `middleware.ts` (Edge runtime) and
 * Node code share one implementation.
 *
 * The mode is derived from provider config; there's no separate `PUBLIC_ONLY` flag to drift.
 * With neither GitHub OAuth nor SMTP, the public surface is served and `/signin/**` and
 * `/workspaces/**` return 404.
 */

/**
 * Any string-valued env, so raw `process.env` passes without a cast. Reads
 * `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` (GitHub) and `SMTP_HOST` + `SMTP_FROM` (magic link).
 * The env schema already rejects a partially configured SMTP provider.
 */
export type AuthProviderEnv = Readonly<Record<string, string | undefined>>;

export interface SignInMode {
  /** GitHub OAuth is fully configured. */
  github: boolean;
  /** The email magic link is fully configured. */
  email: boolean;
  /** At least one provider works, so accounts and case workspaces exist here. */
  enabled: boolean;
  /** No provider at all: this deployment serves the public surface and nothing else. */
  publicOnly: boolean;
}

/** Set and non-blank (`KEY=` in `.env` yields an empty string). */
function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function deriveSignInMode(source: AuthProviderEnv): SignInMode {
  const github = present(source.AUTH_GITHUB_ID) && present(source.AUTH_GITHUB_SECRET);
  const email = present(source.SMTP_HOST) && present(source.SMTP_FROM);
  const enabled = github || email;
  return { github, email, enabled, publicOnly: !enabled };
}

/** Boot log line for public-only mode: what's missing and how to enable it. No brand name. */
export const PUBLIC_ONLY_NOTICE =
  "Public-only mode: no sign-in method is configured, so accounts, case workspaces and the " +
  "sign-in pages are not served. Everything else — the map, the tools, the directory, the " +
  "playbooks, search and live — is public and unaffected. To enable sign-in, set " +
  "AUTH_GITHUB_ID and AUTH_GITHUB_SECRET (a GitHub OAuth app, no cost), or all five SMTP_ " +
  "variables (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM), then restart. " +
  "See .env.example.";

/** Boot log line when sign-in is enabled. */
export const SIGN_IN_ENABLED_NOTICE = "Sign-in is enabled; case workspaces are served.";

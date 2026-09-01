/**
 * Which sign-in methods this deployment actually has — and therefore whether it has a
 * signed-in surface at all.
 *
 * ## Why this file has no imports
 *
 * It is read from three places with three different runtimes: `lib/env.ts` in Node, the
 * route guards in the Node server, and `middleware.ts` in the **Edge** sandbox, where the
 * `pg` driver, `pino` and most Node built-ins do not exist. A pure function over a record of
 * strings is the only shape all three can share, and sharing it is the point: two
 * implementations of "is sign-in configured" is one drift away from a nav that offers a
 * sign-in the server refuses, or hides one that works.
 *
 * ## Why the mode is derived and never declared
 *
 * There is deliberately no `PUBLIC_ONLY=true` flag. A flag is a second source of truth that
 * disagrees with the first the moment somebody adds SMTP and forgets to set it — and the
 * disagreement is silent in both directions. The configuration IS the mode: no provider
 * means no sign-in, which means the signed-in surface is not served.
 *
 * ## What public-only mode is
 *
 * The map, the Toolbench, the directory, the playbooks, search, live and the legal pages are
 * all readable with no account; only case workspaces need a session (product-brief §2a).
 * A deployment with neither GitHub OAuth nor SMTP therefore serves everything it can serve,
 * and answers 404 for `/signin/**` and `/workspaces/**` rather than offering a sign-in that
 * cannot complete. See `docs/decisions/0032-public-only-deployment-mode.md`.
 */

/**
 * Any string-valued environment. Four keys are read and the rest ignored:
 *
 *   `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET`  → GitHub OAuth
 *   `SMTP_HOST` + `SMTP_FROM`                → the email magic link
 *
 * It is this loose ON PURPOSE: raw `process.env` (an interface with a string index signature)
 * must be passable in middleware without a cast, and the parsed `ServerEnv` — whose
 * `SMTP_PORT` is a number — is handed in as an explicit four-key literal from `lib/env.ts`,
 * where naming the four is documentation rather than ceremony.
 *
 * SMTP is judged on host and from-address alone. The env schema already refuses to boot on a
 * partially set provider, so within a running process "host is set" implies all five; the
 * pair is checked rather than one so that the raw-`process.env` reader in middleware is not
 * relying on that implication.
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

/** Set, and not merely present-and-blank. An operator who clears a value in `.env` by
 * deleting the text after the `=` leaves an empty string, not an absent key. */
function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function deriveSignInMode(source: AuthProviderEnv): SignInMode {
  const github = present(source.AUTH_GITHUB_ID) && present(source.AUTH_GITHUB_SECRET);
  const email = present(source.SMTP_HOST) && present(source.SMTP_FROM);
  const enabled = github || email;
  return { github, email, enabled, publicOnly: !enabled };
}

/**
 * The one line the operator sees at boot in public-only mode.
 *
 * It has to answer, without them reading any source: what is missing, what that costs, and
 * exactly what to set to fix it. A log line that says only "public-only mode" sends someone
 * looking for a flag that does not exist.
 *
 * No brand string — the product name lives in `config/brand.ts` and a log line is not
 * allowed to be the place a rename gets missed.
 */
export const PUBLIC_ONLY_NOTICE =
  "Public-only mode: no sign-in method is configured, so accounts, case workspaces and the " +
  "sign-in pages are not served. Everything else — the map, the tools, the directory, the " +
  "playbooks, search and live — is public and unaffected. To enable sign-in, set " +
  "AUTH_GITHUB_ID and AUTH_GITHUB_SECRET (a GitHub OAuth app, no cost), or all five SMTP_ " +
  "variables (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM), then restart. " +
  "See .env.example.";

/** Its counterpart, so the log answers "can anyone sign in here?" in both directions. */
export const SIGN_IN_ENABLED_NOTICE = "Sign-in is enabled; case workspaces are served.";

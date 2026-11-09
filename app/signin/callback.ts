import { safeRedirect } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * `callbackUrl` comes from the query string, so it's attacker-controlled (open redirect).
 * `safeRedirect` returns the base URL on an origin mismatch, hence the extra leading-slash
 * check.
 */

export const DEFAULT_CALLBACK = "/workspaces";

export function resolveCallbackUrl(raw: string | string[] | undefined): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate) return DEFAULT_CALLBACK;
  const resolved = safeRedirect(candidate, env.APP_URL);
  return resolved.startsWith("/") ? resolved : DEFAULT_CALLBACK;
}

/**
 * One line above the form saying what the account is for. The tool variant doesn't name the
 * entry: that would mean a catalogue read, and sign-in must work when the DB is struggling.
 */
export function signInContextLine(callbackUrl: string): string | null {
  if (callbackUrl.startsWith("/workspaces/new") && callbackUrl.includes("playbook=")) {
    return "Sign in to start this case. The playbook itself stays readable either way.";
  }
  if (callbackUrl.startsWith("/playbooks/")) {
    return "Sign in to start this case. The playbook itself stays readable either way.";
  }
  if (callbackUrl.startsWith("/tools/")) {
    return "Sign in to save this entry to a case. It'll be saved as soon as you're back.";
  }
  return null;
}

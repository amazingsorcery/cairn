import { safeRedirect } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * Where a sign-in should land, and what the page says about why it is being asked for.
 *
 * `callbackUrl` arrives from the query string, which makes it attacker-controlled: it is
 * the open-redirect surface of the whole product. `safeRedirect` (`lib/auth-redirect.ts`)
 * parses it against our own origin and returns the base URL when it does not match, which
 * is why the result is re-checked for a leading slash here — belt and braces on the one
 * value that is reflected back into a redirect.
 */

export const DEFAULT_CALLBACK = "/workspaces";

export function resolveCallbackUrl(raw: string | string[] | undefined): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate) return DEFAULT_CALLBACK;
  const resolved = safeRedirect(candidate, env.APP_URL);
  return resolved.startsWith("/") ? resolved : DEFAULT_CALLBACK;
}

/**
 * One line above the form saying what the account is for, when we know
 * (wireframe 10, `docs/design/states.md` §4.7).
 *
 * The tool variant does NOT name the entry. Naming it would mean reading the catalogue from
 * the sign-in page, and this is the one route that has to work when the rest of the product
 * is failing. See `docs/frontend/HANDOFF-workspaces.md` §7.
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

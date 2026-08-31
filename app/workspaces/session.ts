import { redirect } from "next/navigation";

import { currentUser, type SessionUser } from "@/lib/auth";

/**
 * The session gate for `/workspaces/**`.
 *
 * `sitemap.md` §10.2 is a route-level invariant: no route under `/workspaces` is reachable
 * without a session, verified by an E2E test that requests each path signed out and asserts
 * a redirect to `/signin`. This is that redirect, in one place, so a new route under
 * `/workspaces` cannot forget it in its own way.
 *
 * The `callbackUrl` carries the reader back to exactly where they were, which is what makes
 * the sign-in round trip non-destructive (`docs/design/flows.md` M3). It is a same-origin
 * path built here from the route's own identifiers — never reflected from a query string —
 * and `safeRedirect` in `lib/auth-redirect.ts` re-checks the origin server-side regardless.
 *
 * THIS IS NOT THE AUTHORISATION. It establishes *who* is asking; every query and every
 * mutation still carries `user_id` into SQL (architecture HANDOFF §7). A guard clause that
 * some later code path forgets is exactly the failure `assertOwnsWorkspace` exists to make
 * impossible.
 */
export async function requireSession(callbackPath: string): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(callbackPath)}`);
  return user;
}

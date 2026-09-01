import { redirect } from "next/navigation";

import { currentUser, type SessionUser } from "@/lib/auth";
import { requireSignInEnabled } from "@/lib/session-surface";

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
  /*
   * PUBLIC-ONLY MODE FIRST, before the session is even looked up.
   *
   * With no sign-in method configured there is no `/signin` to send anyone to, so the
   * redirect below would land on a 404 having first advertised an account that cannot be
   * created. `requireSignInEnabled` answers 404 here instead, which is what makes the whole
   * `/workspaces` tree absent rather than broken (ADR 0032).
   *
   * It runs before `currentUser()` deliberately: a session cookie left over from a
   * deployment that once had a provider is not a working sign-in, and must not open a
   * surface whose sign-out and sign-in paths are no longer served.
   */
  requireSignInEnabled();

  const user = await currentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(callbackPath)}`);
  return user;
}

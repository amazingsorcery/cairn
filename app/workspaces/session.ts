import { redirect } from "next/navigation";

import { currentUser, type SessionUser } from "@/lib/auth";
import { requireSignInEnabled } from "@/lib/session-surface";

/**
 * Session gate for `/workspaces/**`: redirects to `/signin` with a same-origin
 * `callbackUrl` built from the route's own path.
 *
 * Not authorisation: every query and mutation still scopes by `user_id` in SQL.
 */
export async function requireSession(callbackPath: string): Promise<SessionUser> {
  /*
   * With no sign-in method configured, 404 instead of redirecting to a `/signin` that
   * doesn't exist. Runs before `currentUser()` so a stale session cookie can't open it.
   */
  requireSignInEnabled();

  const user = await currentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(callbackPath)}`);
  return user;
}

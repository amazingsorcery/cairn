import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { currentUser, isEditor, type SessionUser } from "@/lib/auth";
import { pageMetadata } from "@/lib/metadata";

/**
 * The role gate on every `/admin` page. sitemap.md §8.
 *
 * A NON-EDITOR GETS 404, NOT 403. A 403 confirms that the route exists and that the visitor
 * merely lacks the role, which is the same information leak `lib/queries/workspaces.ts`
 * avoids by making a non-owner's query return nothing. The editorial surface should be
 * indistinguishable from a typo for anyone not entitled to see it.
 *
 * THIS IS CHECKED ON EVERY PAGE, not only in the layout. A layout guard is real, but it is
 * one refactor away from not being: a route rendered outside this layout, a parallel route,
 * or a `loading.tsx` that streams before the layout resolves. The check is cheap — the
 * session row is already loaded for the request — and it is the only thing standing between
 * a `user` and the drafts.
 *
 * IT IS ALSO NOT THE ONLY CHECK. `middleware.ts` redirects a visitor with no session cookie,
 * and every Server Action re-checks the role against the database (`lib/actions/index.ts`).
 * Middleware alone is not authorisation, and neither is a hidden nav link.
 */

export async function requireEditorPage(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user || !isEditor(user.role)) notFound();
  return user;
}

/**
 * `/admin/connectors` and `/admin/taxonomy` are `admin`, not `editor` (sitemap.md §8).
 * Connectors carry the kill-switch, the quota envelope and the recorded legal basis, which
 * are operator responsibilities rather than editorial ones.
 */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user || user.role !== "admin") notFound();
  return user;
}

/**
 * Page metadata for an `/admin` route, which is NOT the same thing as the page's own title.
 *
 * A static `export const metadata` is resolved even when the page body calls `notFound()`, so
 * a signed-in `user` who guesses `/admin/connectors` would get the 404 body under a
 * `<title>Connectors</title>` — which tells them precisely what the 404 exists to withhold.
 * Resolving the title behind the same role check closes that.
 *
 * The denied branch carries no canonical URL and no description: there is nothing to say
 * about a page the caller is not entitled to know exists.
 */
export async function adminMetadata(
  input: { title: string; description: string; path: string },
  level: "editor" | "admin" = "editor",
): Promise<Metadata> {
  const user = await currentUser();
  const entitled = user !== null && (level === "admin" ? user.role === "admin" : isEditor(user.role));
  if (!entitled) return { title: "Not found", robots: { index: false, follow: false } };
  return pageMetadata({ ...input, index: false });
}

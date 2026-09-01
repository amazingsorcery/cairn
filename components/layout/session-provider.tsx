"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Client-side session context for the header only.
 *
 * WHY THE HEADER DOES NOT CALL `auth()` ON THE SERVER
 * ---------------------------------------------------
 * `auth()` reads cookies. A cookie read anywhere in the root layout applies to every route
 * that uses the layout, which is all of them — so a server-rendered account area would
 * silently opt `/`, `/tools/[slug]`, `/playbooks/[slug]`, `/directory/[category]`,
 * `/tags/[slug]` and `/live` out of static generation and delete their ISR caches.
 * `docs/architecture/sitemap.md` §10.1 states that as a route-level invariant and QA
 * asserts it.
 *
 * So the header renders its signed-out state on the server — a "sign in" link, which is
 * correct and useful for the majority of visitors, who are anonymous — and this provider
 * lets two small leaves upgrade it after hydration for the reader who is signed in. The
 * cost is one `/api/auth/session` request per page view; the alternative cost is
 * re-rendering every public page from scratch on every request on a 2 GB VPS with no CDN
 * in front of it (ADR 0006).
 *
 * Refetching is off. This session is used for a nav label and a sign-out control; polling
 * it, or re-fetching whenever the reader tabs back to a page they left open all day, is
 * traffic with no reader-visible benefit. A session that is revoked server-side is still
 * enforced on the next server request, which is the request that matters — `lib/auth.ts`
 * uses database sessions precisely so revocation is immediate where it counts.
 *
 * `{children}` stays a Server Component tree: this file only opens a context boundary.
 *
 * WHEN `enabled` IS FALSE THE PROVIDER IS NOT MOUNTED AT ALL. That is public-only mode
 * (ADR 0032): no sign-in method is configured, so no session can exist, and the only two
 * components that read one are not rendered. Mounting it anyway would cost one
 * `/api/auth/session` request per page view for an answer that is always "nobody" — on the
 * VPS this runs on, that is the whole reason ADR 0006 weighs this provider's cost at all.
 * The children are returned untouched, so the tree is otherwise identical.
 */
export function HeaderSessionProvider({
  children,
  enabled,
}: {
  children: React.ReactNode;
  enabled: boolean;
}) {
  if (!enabled) return <>{children}</>;

  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={0}>
      {children}
    </SessionProvider>
  );
}

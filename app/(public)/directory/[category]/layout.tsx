import { notFound } from "next/navigation";

import { getCategoryBySlug } from "@/lib/queries/taxonomy";

/**
 * Existence guard for `/directory/[category]`. It exists for ONE reason: to make `notFound()` in this
 * segment produce an HTTP **404** instead of a 200.
 *
 * WHY THIS FILE IS NECESSARY
 * --------------------------
 * A `loading.tsx` creates a Suspense boundary, and Next streams that fallback as soon as it
 * is reached — which sends the HTTP status line. A `notFound()` thrown afterwards, from
 * inside `page.tsx`, still swaps the body for the not-found UI, so the page LOOKS right —
 * but the status was committed as 200 and cannot be changed. The observed symptom was a
 * correct-looking 404 served as `200 OK` with `s-maxage=3600`, which a search engine indexes
 * as real content and a CDN caches for an hour.
 *
 * A layout renders ABOVE its own segment's loading boundary, so a check here runs before
 * anything is flushed and the 404 survives. That keeps the designed skeleton in
 * `loading.tsx` AND gets the status right, rather than trading one for the other.
 *
 * The read costs nothing: `getCategoryBySlug` is `unstable_cache`d, so the page's identical call a moment
 * later is a cache hit, not a second round trip.
 *
 * THE RULE, proven against a production build: **any `loading.tsx` at or above the segment
 * that calls `notFound()` commits HTTP 200 before the page renders.** See
 * `docs/backend/HANDOFF.md` §6.6 for the full experiment and the remaining known case.
 */
export const revalidate = 3600;

export default async function CategoryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  if (!(await getCategoryBySlug(category))) notFound();
  return <>{children}</>;
}

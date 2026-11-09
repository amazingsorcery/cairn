import { notFound } from "next/navigation";

import { getCategoryBySlug } from "@/lib/queries/taxonomy";

/**
 * Existence guard so an unknown category returns HTTP 404, not 200.
 *
 * `loading.tsx` streams its Suspense fallback immediately, committing a 200 status; a later
 * `notFound()` in `page.tsx` swaps the body but can't change the status. A layout renders
 * above its segment's loading boundary, so checking here gets the 404 out first.
 * `getCategoryBySlug` is cached, so the page's repeat call is free.
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

import { notFound } from "next/navigation";

import { getToolRecord } from "@/lib/queries/tools";

/**
 * Existence guard so an unknown tool returns HTTP 404, not 200.
 *
 * `loading.tsx` streams its Suspense fallback immediately, committing a 200 status; a later
 * `notFound()` in `page.tsx` swaps the body but can't change the status. A layout renders
 * above its segment's loading boundary, so checking here gets the 404 out first.
 * `getToolRecord` is cached, so the page's repeat call is free.
 */
export const revalidate = 3600;

export default async function ToolLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!(await getToolRecord(slug))) notFound();
  return <>{children}</>;
}

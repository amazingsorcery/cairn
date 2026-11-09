import { notFound } from "next/navigation";

import { assertOwnsWorkspace } from "@/lib/queries/workspaces";
import { requireSession } from "../session";

/**
 * Existence-and-ownership check for `/workspaces/[id]`, so `notFound()` returns a real 404.
 * A `loading.tsx` at or above the segment commits HTTP 200 before the page renders, so the
 * check must run in a layout. A non-owner gets the same 404 as a missing case.
 *
 * Costs one indexed query; not cached because it depends on the session.
 *
 * Not the authorisation boundary: layouts don't re-render on every navigation, so the page
 * must keep re-checking ownership in SQL.
 */
export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSession(`/workspaces/${id}`);

  // A malformed id is a 404, not a `22P02` from the driver's uuid parser.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  // "Does not exist" and "is not yours" are the same answer.
  if (!(await assertOwnsWorkspace(id, user.id))) notFound();

  return <>{children}</>;
}

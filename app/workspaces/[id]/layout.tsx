import { notFound } from "next/navigation";

import { assertOwnsWorkspace } from "@/lib/queries/workspaces";
import { requireSession } from "../session";

/**
 * Existence-and-ownership guard for `/workspaces/[id]`. It exists for ONE reason: to make
 * `notFound()` in this segment produce an HTTP **404** instead of a 200.
 *
 * Same defect, same fix, same reasoning as `app/(public)/playbooks/[slug]/layout.tsx` — the
 * rule proven there against a production build is: **any `loading.tsx` at or above the
 * segment that calls `notFound()` commits HTTP 200 before the page renders.** This route has
 * its own `loading.tsx` (a three-region skeleton `docs/design/states.md` §7.2 asks for), so
 * the check has to run in a layout, which renders above that boundary.
 *
 * IT MATTERS MORE HERE THAN ANYWHERE ELSE IN THE PRODUCT. A 200 on a public catalogue slug is
 * an SEO problem. A 200 here is the response a signed-in NON-OWNER gets, and architecture
 * HANDOFF §11 assertion 2 requires 404 precisely so the status cannot be used to enumerate
 * whose case files exist. The body was already correct and byte-identical to a genuine
 * miss — so this was never an information leak — but the assertion is about the status line
 * and the status line was wrong.
 *
 * COST: one extra round trip, `select id from workspaces where id = $1 and user_id = $2`.
 * It is a single indexed equality on the primary key plus the denormalised `user_id` that
 * ADR 0008 put there for exactly this shape of predicate, and it is deliberately NOT cached
 * — nothing whose result depends on the session may enter `unstable_cache` (`caching.md`
 * §6). Four small queries on a page whose whole value is having the case in front of you is
 * the right trade for a correct status.
 *
 * The page re-checks ownership anyway, in SQL, and must keep doing so. A guard in a layout is
 * a status-code fix, not an authorisation boundary: layouts do not re-render on every
 * navigation within a segment, so treating this as the security check would be the classic
 * way to grow a hole.
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

  // "Does not exist" and "is not yours" are the same answer. Deliberately.
  if (!(await assertOwnsWorkspace(id, user.id))) notFound();

  return <>{children}</>;
}

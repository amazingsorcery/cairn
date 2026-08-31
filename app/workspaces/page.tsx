import Link from "next/link";

import { CaseCard } from "@/components/workspaces/case-card";
import { Button } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";
import { listWorkspaces } from "@/lib/queries/workspaces";
import { requireSession } from "./session";

/**
 * `/workspaces` — the reader's own cases.
 *
 * `force-dynamic` and never cached at any layer (sitemap.md §7): a user's case file must
 * not touch a shared cache, a CDN or the ISR filesystem cache. That is a hard requirement,
 * not a performance trade-off, which is why `lib/queries/workspaces.ts` wraps none of its
 * functions in `unstable_cache` and why nothing here adds a `revalidate`.
 *
 * `listWorkspaces` binds `user_id` from the session into SQL. There is no "all workspaces"
 * query in the data layer to accidentally call.
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Your cases",
  description: "Case workspaces: a checklist from a playbook, saved tools, and timestamped notes.",
  path: "/workspaces",
  index: false,
});

export default async function WorkspacesPage() {
  const user = await requireSession("/workspaces");
  const workspaces = await listWorkspaces(user.id);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Your cases</h1>
          <p className="mt-3 max-w-[68ch] text-lg text-foreground-secondary">
            A checklist from a playbook, the tools you saved, and your own timestamped notes.
            Nobody else can read these.
          </p>
        </div>
        {workspaces.length > 0 ? (
          <Button asChild size="lg">
            <Link href="/workspaces/new">new blank case</Link>
          </Button>
        ) : null}
      </div>

      <p aria-live="polite" className="sr-only">
        {workspaces.length === 1 ? "1 case" : `${workspaces.length} cases`}
      </p>

      {workspaces.length === 0 ? (
        <div className="mt-10 max-w-[68ch] rounded-lg border border-border bg-card p-6">
          <h2 className="text-xl font-semibold tracking-tight">No cases yet</h2>
          <p className="mt-2 text-base leading-relaxed text-foreground-secondary">
            Start one from a playbook, or from a blank case.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button asChild className="h-11">
              <Link href="/playbooks">browse playbooks</Link>
            </Button>
            <Button asChild variant="outline" className="h-11">
              <Link href="/workspaces/new">new blank case</Link>
            </Button>
          </div>
        </div>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <CaseCard workspace={workspace} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

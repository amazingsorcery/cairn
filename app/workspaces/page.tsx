import * as React from "react";
import Link from "next/link";

import { CaseCard } from "@/components/workspaces/case-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pageMetadata } from "@/lib/metadata";
import { listWorkspaces } from "@/lib/queries/workspaces";
import { metadataUnlessPublicOnly, requireSignInEnabled } from "@/lib/session-surface";
import { requireSession } from "./session";

/**
 * `/workspaces`: the user's own cases. Never cached at any layer; `listWorkspaces` scopes
 * by the session's `user_id`.
 *
 * The skeleton is an in-page `<Suspense>`, not a `loading.tsx`: a segment `loading.tsx`
 * would also wrap `[id]` and commit a 200 before its `notFound()` could set 404.
 */

export const dynamic = "force-dynamic";

/* In public-only mode the 404 would otherwise render under "Your cases" as the title. */
export const metadata = metadataUnlessPublicOnly(
  pageMetadata({
    title: "Your cases",
    description:
      "Case workspaces: a checklist from a playbook, saved tools, and timestamped notes.",
    path: "/workspaces",
    index: false,
  }),
);

/** The heading and lead. Synchronous, no database read, so it paints immediately. */
export default function WorkspacesPage() {
  /*
   * Public-only mode check, here and synchronously: inside the suspended `CaseList` the
   * heading would already have streamed with a 200.
   */
  requireSignInEnabled();

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Your cases</h1>
        <p className="mt-3 max-w-[68ch] text-lg text-foreground-secondary">
          A checklist from a playbook, the tools you saved, and your own timestamped notes.
          Nobody else can read these.
        </p>
      </div>

      <React.Suspense fallback={<CaseListSkeleton />}>
        <CaseList />
      </React.Suspense>
    </div>
  );
}

/** Everything that waits on the session and the database. */
async function CaseList() {
  const user = await requireSession("/workspaces");
  const workspaces = await listWorkspaces(user.id);

  return (
    <>
      {workspaces.length > 0 ? (
        <div className="mt-6 flex justify-end">
          <Button asChild size="lg">
            <Link href="/workspaces/new">new blank case</Link>
          </Button>
        </div>
      ) : null}

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
    </>
  );
}

/** List skeleton; the heading above paints immediately. */
function CaseListSkeleton() {
  return (
    <>
      <p aria-live="polite" className="sr-only">
        Loading your cases…
      </p>
      <div aria-hidden="true" className="mt-8 flex flex-col gap-4">
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-lg border border-border bg-card p-5">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="mt-3 h-4 w-56" />
            <Skeleton className="mt-3 h-4 w-40" />
          </div>
        ))}
      </div>
    </>
  );
}

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
 * `/workspaces` — the reader's own cases.
 *
 * `force-dynamic` and never cached at any layer (sitemap.md §7): a user's case file must
 * not touch a shared cache, a CDN or the ISR filesystem cache. That is a hard requirement,
 * not a performance trade-off, which is why `lib/queries/workspaces.ts` wraps none of its
 * functions in `unstable_cache` and why nothing here adds a `revalidate`.
 *
 * `listWorkspaces` binds `user_id` from the session into SQL. There is no "all workspaces"
 * query in the data layer to accidentally call.
 *
 * WHY THE SKELETON IS AN IN-PAGE `<Suspense>` AND NOT A `loading.tsx` — QA finding Q-07.
 * A `loading.tsx` at this segment creates a Suspense boundary that wraps the CHILD segment
 * `[id]` too. Next streams that fallback as soon as it is reached, which sends the HTTP
 * status line — so `notFound()` in `/workspaces/[id]`, however early it ran, could only swap
 * the body and never the status. A non-owner got the correct not-found body with `200 OK`.
 *
 * Moving the boundary inside this page scopes it to this page's own content. Same treatment,
 * same reasoning as `/directory` in commit `753cf1a`; the skeleton is moved, not deleted,
 * because `/workspaces` is dynamic and genuinely waits on a query.
 */

export const dynamic = "force-dynamic";

/*
 * The title follows the route. In public-only mode this page 404s inside `requireSession`,
 * and a static `metadata` export resolves anyway — so without this the reader gets a 404 body
 * under `<title>Your cases</title>`, which reads as broken rather than absent.
 */
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
   * PUBLIC-ONLY MODE, CHECKED HERE AND NOT ONLY IN `CaseList`.
   *
   * `requireSession` inside the suspended child would 404 too late: this page streams its
   * heading before the boundary resolves, so the status line has already been sent as 200 and
   * `notFound()` could only swap the body — the same mechanism as QA finding I-15, one layer
   * in. Throwing here, synchronously, before any JSX is returned, is what makes `/workspaces`
   * a real 404 in a deployment that has no sign-in (ADR 0032).
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

/**
 * The skeleton that was `app/workspaces/loading.tsx`, unchanged in appearance. The heading
 * and lead are no longer part of it — they are in the shell above and paint immediately, so
 * the reader sees where they are while the list loads.
 */
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

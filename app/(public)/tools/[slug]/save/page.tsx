import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Check, FolderPlus, LogIn } from "lucide-react";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth";
import { pageMetadata } from "@/lib/metadata";
import { listWorkspaces } from "@/lib/queries/workspaces";
import { getToolBySlug } from "@/lib/queries/tools";
import { cn } from "@/lib/utils";

/**
 * `/tools/[slug]/save` — pick a case to save this entry into.
 *
 * THIS IS THE JOIN IN THE VERTICAL SLICE. `product-brief.md` §2 names the path — discover in
 * the directory, open an entry, save it into a case — and until this route existed the path
 * stopped after "open an entry": `addWorkspaceItem` was authorised, rate-limited and tested,
 * and nothing called it, while `components/workspaces/saved-tools.tsx` told the reader to
 * "Save one from any directory entry".
 *
 * WHY THIS IS ITS OWN ROUTE AND NOT A DIALOG ON `/tools/[slug]`.
 *
 * `/tools/[slug]` is **ISR:3600** and `sitemap.md` §10.1 is a route-level invariant: no public
 * route reads `cookies()`, `headers()` or `auth()`. A modal listing the reader's own cases
 * needs the session, and reading it on the tool page would silently opt the most-crawled route
 * in the product out of static generation — the exact trap architecture HANDOFF §8 names. The
 * alternative, fetching the list from the browser, would mean a new endpoint over a user's
 * private case titles for a control most readers never open.
 *
 * A child segment is `force-dynamic` on its own without touching its parent. The tool page
 * stays prerendered at 199 B and ships NO client JavaScript for this at all; the trigger there
 * is a plain GET form with a real submit button. `/playbooks/[slug]` already uses this shape
 * for "start a case from this playbook" — a control that renders for everyone, pointing at a
 * session-gated route — so this is that pattern, not a second one.
 *
 * THE PICKER IS NATIVE FORMS. Each case is a `<form method="post">` posting to
 * `save/submit/route.ts`, whose header records why two Server Action versions were replaced:
 * both could silently drop a save, one before hydration and one after. So this page ships no
 * client component either, and the whole surface works with JavaScript off.
 *
 * IT WRITES NO SQL AND INVENTS NO ACTION. `addWorkspaceItem` re-checks the session,
 * Zod-validates, re-checks ownership inside its transaction, and reads the snapshot title FROM
 * THE DATABASE rather than from the form (ADR 0008). The tool id is resolved by the handler
 * from the route's own slug and is never posted.
 *
 * THE STATES, all rendered rather than hidden:
 *   signed out          — say what a case is, offer sign-in, come back HERE afterwards
 *   signed in, no cases — offer to start one; a first-run reader must not hit a dead control
 *   signed in, cases    — one submit button per case
 *   saved / already / busy / gone / failed — reported above the list, which stays on screen
 */

export const dynamic = "force-dynamic";

/** What the last attempt did, echoed back by the POST handler's redirect. */
type Outcome = "saved" | "already" | "busy" | "gone" | "failed" | "invalid" | "signedout";

const OUTCOMES: readonly string[] = [
  "saved",
  "already",
  "busy",
  "gone",
  "failed",
  "invalid",
  "signedout",
];

interface SavePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function generateMetadata({ params }: SavePageProps) {
  const { slug } = await params;
  const tool = await getToolBySlug(slug);
  return pageMetadata({
    title: tool ? `Save ${tool.name}` : "Save",
    description: "Save this catalogue entry into one of your cases.",
    path: `/tools/${slug}/save`,
    // Session-dependent and private to one reader. Nothing here belongs in an index.
    index: false,
  });
}

export default async function SaveToolPage({ params, searchParams }: SavePageProps) {
  const { slug } = await params;
  const query = await searchParams;

  const tool = await getToolBySlug(slug);
  if (!tool) notFound();

  const user = await currentUser();
  const toolHref = `/tools/${tool.slug}`;

  const rawOutcome = one(query.outcome);
  const outcome = rawOutcome && OUTCOMES.includes(rawOutcome) ? (rawOutcome as Outcome) : null;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[
          { label: "directory", href: "/directory" },
          { label: tool.name, href: toolHref },
          { label: "save to a case" },
        ]}
      />

      <div className="mt-4 max-w-[52ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Save {tool.name}</h1>

        {user === null ? (
          <SignedOut toolHref={toolHref} slug={tool.slug} />
        ) : (
          <SignedIn
            userId={user.id}
            slug={tool.slug}
            toolName={tool.name}
            toolHref={toolHref}
            outcome={outcome}
            outcomeCase={one(query.case) ?? null}
          />
        )}

        <p className="mt-8">
          <Link href={toolHref} className="text-primary font-medium underline underline-offset-4">
            back to {tool.name}
          </Link>
        </p>
      </div>
    </div>
  );
}

/**
 * `states.md` §6.10's register: say what to do, no apology, and never discard the reader's
 * intent. `callbackUrl` returns them to THIS page rather than the tool page — they came here
 * to save something, and landing them one click short of it answers a question they did not
 * ask.
 */
function SignedOut({ toolHref, slug }: { toolHref: string; slug: string }) {
  const callbackUrl = `/tools/${slug}/save`;

  return (
    <>
      <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
        A case is your own file: the entries you saved, a checklist from a playbook, timestamped
        notes, and an export. It is private to your account.
      </p>
      <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
        Sign in to save this entry. You will come straight back here.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href={`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`}>
            <LogIn aria-hidden="true" />
            sign in to save
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href={toolHref}>not now</Link>
        </Button>
      </div>
    </>
  );
}

async function SignedIn({
  userId,
  slug,
  toolName,
  toolHref,
  outcome,
  outcomeCase,
}: {
  userId: string;
  slug: string;
  toolName: string;
  toolHref: string;
  outcome: Outcome | null;
  outcomeCase: string | null;
}) {
  const workspaces = await listWorkspaces(userId);

  if (workspaces.length === 0) {
    /**
     * First run. `states.md` §0's rule for an empty state — name the next action, do not
     * congratulate and do not scold. A dead control with no explanation is the commonest way
     * this feature dies for the person meeting it for the first time.
     */
    return (
      <>
        <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
          You have no cases yet. A case is your own file: the entries you saved, a checklist from a
          playbook, timestamped notes, and an export.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/workspaces/new">
              <FolderPlus aria-hidden="true" />
              start a case
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link href={toolHref}>not now</Link>
          </Button>
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          Start one and come back — {toolName} will be one click from saved.
        </p>
      </>
    );
  }

  const named = workspaces.find((workspace) => workspace.id === outcomeCase) ?? null;

  return (
    <>
      <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
        {workspaces.length === 1 ? "Save it into your case." : "Choose the case to save it into."}
      </p>

      {/*
        The outcome, above the list — and the list stays underneath it, so a retry is the same
        button in the same place rather than a trip back through the tool page.
      */}
      {outcome ? (
        <div className="mt-6">
          <OutcomeMessage
            outcome={outcome}
            toolName={toolName}
            caseTitle={named?.title ?? null}
            caseId={named?.id ?? null}
          />
        </div>
      ) : null}

      <ul className="mt-6 space-y-2">
        {workspaces.map((workspace) => {
          const settled =
            (outcome === "saved" || outcome === "already") && outcomeCase === workspace.id;

          return (
            <li key={workspace.id}>
              <form method="post" action={`/tools/${slug}/save/submit`}>
                <input type="hidden" name="workspaceId" value={workspace.id} />
                <button
                  type="submit"
                  className={cn(
                    "border-input flex min-h-11 w-full items-center gap-3 rounded-md border px-4 py-3 text-left",
                    "hover:bg-accent hover:text-accent-foreground",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                    "focus-visible:ring-offset-background focus-visible:ring-offset-2",
                    settled && "border-success",
                  )}
                >
                  {settled ? (
                    <Check className="text-success size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <FolderPlus
                      className="text-muted-foreground size-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{workspace.title}</span>
                    <span className="tabular text-muted-foreground block text-xs">
                      {workspace.itemCount === 1 ? "1 item" : `${workspace.itemCount} items`}
                    </span>
                  </span>
                </button>
              </form>
            </li>
          );
        })}
      </ul>

      <p className="mt-6">
        <Button asChild variant="outline">
          <Link href="/workspaces/new">start a new case instead</Link>
        </Button>
      </p>
    </>
  );
}

function OutcomeMessage({
  outcome,
  toolName,
  caseTitle,
  caseId,
}: {
  outcome: Outcome;
  toolName: string;
  caseTitle: string | null;
  caseId: string | null;
}) {
  const caseLink =
    caseId && caseTitle ? (
      <Link
        href={`/workspaces/${caseId}`}
        className="text-primary font-medium underline underline-offset-4"
      >
        {caseTitle}
      </Link>
    ) : (
      <Link href="/workspaces" className="text-primary font-medium underline underline-offset-4">
        your cases
      </Link>
    );

  if (outcome === "saved") {
    return (
      <p className="border-success/40 bg-success-surface rounded-md border px-4 py-3 text-sm">
        <Check className="text-success mr-2 inline size-4" aria-hidden="true" />
        {toolName} is saved to {caseLink}.
      </p>
    );
  }

  if (outcome === "already") {
    return (
      <p className="border-border bg-muted rounded-md border px-4 py-3 text-sm">
        {toolName} is already in {caseLink}. Open the case to remove it or add a note.
      </p>
    );
  }

  const copy: Record<"busy" | "gone" | "failed" | "invalid" | "signedout", string> = {
    signedout: "You were signed out. Sign back in and choose a case again — nothing is lost.",
    busy: "That was too many saves in a row. Wait a moment and choose a case again.",
    gone: `${toolName} is no longer available to save. It may have been unpublished since this page loaded.`,
    failed: "The save did not go through. Choose a case to try again.",
    invalid: "That request did not come from this page. Choose a case to try again.",
  };

  return (
    <div className="border-warning/40 bg-warning-surface rounded-md border px-4 py-3 text-sm">
      <p>
        <AlertTriangle className="text-warning mr-2 inline size-4" aria-hidden="true" />
        {copy[outcome]}
      </p>
      <p className="text-muted-foreground mt-2">Nothing was saved.</p>
    </div>
  );
}

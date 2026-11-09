import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Check, FolderPlus, LogIn } from "lucide-react";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth";
import { pageMetadata } from "@/lib/metadata";
import { listWorkspaces } from "@/lib/queries/workspaces";
import { getToolBySlug } from "@/lib/queries/tools";
import { metadataUnlessPublicOnly, requireSignInEnabled } from "@/lib/session-surface";
import { cn } from "@/lib/utils";

/**
 * `/tools/[slug]/save`: pick a case to save this tool into.
 *
 * A separate dynamic route because listing the user's cases needs `auth()`, and reading the
 * session on `/tools/[slug]` would make that page dynamic. The tool page links here with a
 * plain GET form.
 *
 * Each case is a native POST form to `save/submit/route.ts` (see that file for why not a
 * Server Action). `addWorkspaceItem` handles session, validation and ownership, and reads the
 * snapshot title from the database. The tool id comes from the route slug, never the form.
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
  return metadataUnlessPublicOnly(
    pageMetadata({
      title: tool ? `Save ${tool.name}` : "Save",
      description: "Save this catalogue entry into one of your cases.",
      path: `/tools/${slug}/save`,
      // Session-dependent and private.
      index: false,
    }),
  );
}

export default async function SaveToolPage({ params, searchParams }: SavePageProps) {
  // Not served in public-only mode (no sign-in configured). See `lib/session-surface.ts`.
  requireSignInEnabled();

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

/** `callbackUrl` returns the reader to this picker, not the tool page, after sign-in. */
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
    /** No cases yet: offer to start one. */
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

      {/* Outcome above the list; the list stays so retry is one click. */}
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

import Link from "next/link";
import { AlertTriangle, Check, FolderPlus, LogIn } from "lucide-react";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { formatClockUtc } from "@/components/live/live-format";
import { currentUser } from "@/lib/auth";
import { findCachedFeature, type ResolvedLiveFeature } from "@/lib/live/feature-cache";
import { pageMetadata } from "@/lib/metadata";
import { listWorkspaces } from "@/lib/queries/workspaces";
import { metadataUnlessPublicOnly, requireSignInEnabled } from "@/lib/session-surface";
import { cn } from "@/lib/utils";

/**
 * `/map/save`: save one live feature into a case.
 *
 * Only the source slug and feature id come from the query string; everything else is read
 * from `lib/live/feature-cache.ts`, so nothing about the feature is trusted from the browser.
 * If the cache no longer has it we say so rather than re-fetch: sources like adsb.lol keep no
 * history, so a re-fetch would pair the current position with the old timestamp.
 *
 * Separate route because listing the user's cases needs `auth()` and `/map` is public.
 * Uses native POST forms (no client JS), which proved more reliable than Server Actions.
 * Never calls `notFound()`: an expired feature is an expected state, and `/map`'s
 * `loading.tsx` would commit a 200 anyway.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = metadataUnlessPublicOnly(
  pageMetadata({
    title: "Save a map feature",
    description: "Keep a live map feature in one of your cases.",
    path: "/map/save",
    // Session-dependent and private.
    index: false,
  }),
);

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

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function SaveMapFeaturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Not served in public-only mode (no sign-in configured). See `lib/session-surface.ts`.
  requireSignInEnabled();

  const query = await searchParams;
  const sourceSlug = one(query.source);
  const featureRef = one(query.feature);

  const resolved =
    sourceSlug && featureRef ? findCachedFeature(sourceSlug, featureRef) : null;

  const user = await currentUser();
  const rawOutcome = one(query.outcome);
  const outcome = OUTCOMES.includes(rawOutcome) ? (rawOutcome as Outcome) : null;

  /* Back to the picker, so signing in does not lose which feature they were keeping. */
  const here = `/map/save?source=${encodeURIComponent(sourceSlug)}&feature=${encodeURIComponent(featureRef)}`;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb items={[{ label: "map", href: "/map" }, { label: "save to a case" }]} />

      <div className="mt-4 max-w-[60ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {resolved ? `Save ${resolved.feature.label}` : "Save a map feature"}
        </h1>

        {resolved === null ? (
          <Gone />
        ) : (
          <>
            <FeatureSummary resolved={resolved} />

            {user === null ? (
              <SignedOut callbackUrl={here} />
            ) : (
              <SignedIn
                userId={user.id}
                label={resolved.feature.label}
                sourceSlug={sourceSlug}
                featureRef={featureRef}
                outcome={outcome}
                outcomeCase={one(query.case) || null}
              />
            )}
          </>
        )}

        {/* `Gone` carries its own control, so this would be the same link twice. */}
        {resolved === null ? null : (
          <p className="mt-8">
            <Link href="/map" className="text-primary font-medium underline underline-offset-4">
              back to the map
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Preview of what will be saved. Shows the observation time, the licence-required credit, and
 * a precision caveat (the coordinate may be a coarse centroid).
 */
function FeatureSummary({ resolved }: { resolved: ResolvedLiveFeature }) {
  const { feature } = resolved;
  const precision = feature.precision ?? null;

  return (
    <section
      aria-label="What will be saved"
      className="border-border bg-card mt-5 rounded-lg border p-4"
    >
      <p className="text-foreground-secondary text-base leading-relaxed">
        A copy of this observation is kept in your case. It is never refreshed and never
        re-checked, because the source keeps no history — by tomorrow it will not have this
        record either.
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">Observed</dt>
          <dd className="tabular text-sm">
            <time dateTime={resolved.observedAt.toISOString()}>
              {formatClockUtc(resolved.observedAt.toISOString())}
            </time>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">Source record</dt>
          <dd className="font-mono text-sm break-words">{feature.id}</dd>
        </div>
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-muted-foreground text-xs tracking-wide uppercase">Position</dt>
          <dd className="tabular font-mono text-sm">
            {feature.latitude.toFixed(4)}, {feature.longitude.toFixed(4)}
            {feature.altitude === undefined ? null : ` · ${Math.round(feature.altitude)} m`}
          </dd>
          {precision ? (
            <p className="text-foreground-secondary mt-1 text-sm leading-relaxed">
              <span className="text-foreground font-semibold">Approximate position.</span>{" "}
              {precision.note}
            </p>
          ) : null}
        </div>
      </dl>

      {/* Credit sits with the data, not in a footer. */}
      <p className="text-foreground-secondary mt-4 border-t border-border pt-3 text-sm leading-relaxed">
        {resolved.sourceName} · {resolved.attribution.text} · {resolved.attribution.licence}
      </p>
    </section>
  );
}

/** The feature has aged out of the cache. No retry, since there's nothing to retry. */
function Gone() {
  return (
    <>
      <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
        That feature is no longer available to save. Live sources publish a moving window and
        keep no history, so once it has left the feed there is nothing left to copy — and
        showing you the same aircraft&rsquo;s position now, under the old time, would be worse
        than showing you nothing.
      </p>
      <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
        Open the map, pick the feature again, and save it from there.
      </p>
      <div className="mt-6">
        <Button asChild size="lg">
          <Link href="/map">back to the map</Link>
        </Button>
      </div>
    </>
  );
}

/** `callbackUrl` returns the reader to this page with the same feature after sign-in. */
function SignedOut({ callbackUrl }: { callbackUrl: string }) {
  return (
    <>
      <p className="text-foreground-secondary mt-5 text-base leading-relaxed">
        A case is your own file: what you saved, a checklist from a playbook, timestamped notes,
        and an export. It is private to your account.
      </p>
      <p className="text-foreground-secondary mt-3 text-base leading-relaxed">
        Sign in to save this. You will come straight back here, still holding it.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href={`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`}>
            <LogIn aria-hidden="true" />
            sign in to save
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/map">not now</Link>
        </Button>
      </div>
    </>
  );
}

async function SignedIn({
  userId,
  label,
  sourceSlug,
  featureRef,
  outcome,
  outcomeCase,
}: {
  userId: string;
  label: string;
  sourceSlug: string;
  featureRef: string;
  outcome: Outcome | null;
  outcomeCase: string | null;
}) {
  const workspaces = await listWorkspaces(userId);

  if (workspaces.length === 0) {
    /** No cases yet. Warns that the feature may leave the feed before they come back. */
    return (
      <>
        <p className="text-foreground-secondary mt-5 text-base leading-relaxed">
          You have no cases yet. A case is your own file: what you saved, a checklist from a
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
            <Link href="/map">not now</Link>
          </Button>
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          Start one and come back. If this feature has left the feed by then you will need to
          find it on the map again.
        </p>
      </>
    );
  }

  const named = workspaces.find((workspace) => workspace.id === outcomeCase) ?? null;

  return (
    <>
      <p className="text-foreground-secondary mt-5 text-base leading-relaxed">
        {workspaces.length === 1 ? "Save it into your case." : "Choose the case to save it into."}
      </p>

      {/* Outcome announced via aria-live; the list stays below so retry is one click. */}
      <div aria-live="polite" className="mt-6 empty:mt-0">
        {outcome ? (
          <OutcomeMessage
            outcome={outcome}
            label={label}
            caseTitle={named?.title ?? null}
            caseId={named?.id ?? null}
          />
        ) : null}
      </div>

      <ul className="mt-6 space-y-2">
        {workspaces.map((workspace) => {
          const settled =
            (outcome === "saved" || outcome === "already") && outcomeCase === workspace.id;

          return (
            <li key={workspace.id}>
              <form method="post" action="/map/save/submit">
                {/*
                  workspaceId is re-checked against the session user server-side. source and
                  feature are only a lookup key into our cache.
                */}
                <input type="hidden" name="workspaceId" value={workspace.id} />
                <input type="hidden" name="source" value={sourceSlug} />
                <input type="hidden" name="feature" value={featureRef} />
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
  label,
  caseTitle,
  caseId,
}: {
  outcome: Outcome;
  label: string;
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
        {label} is saved to {caseLink}, with its source, its time and its credit.
      </p>
    );
  }

  if (outcome === "already") {
    return (
      <p className="border-border bg-muted rounded-md border px-4 py-3 text-sm">
        {label} is already in {caseLink}. A feature is kept once per case — a second copy would
        be a track built one click at a time, which this product does not keep. Add a note to
        the case to record what changed.
      </p>
    );
  }

  const copy: Record<"busy" | "gone" | "failed" | "invalid" | "signedout", string> = {
    signedout: "You were signed out. Sign back in and choose a case again — nothing is lost.",
    busy: "That was too many saves in a row. Wait a moment and choose a case again.",
    gone: "That feature has left the source's feed since this page loaded, so there is nothing left to copy. Open the map and pick it again.",
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

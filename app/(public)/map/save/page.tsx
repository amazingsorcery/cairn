import Link from "next/link";
import { AlertTriangle, Check, FolderPlus, LogIn } from "lucide-react";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { formatClockUtc } from "@/components/live/live-format";
import { currentUser } from "@/lib/auth";
import { findCachedFeature, type ResolvedLiveFeature } from "@/lib/live/feature-cache";
import { pageMetadata } from "@/lib/metadata";
import { listWorkspaces } from "@/lib/queries/workspaces";
import { cn } from "@/lib/utils";

/**
 * `/map/save` — keep one live feature in a case.
 *
 * THIS IS THE JOIN BETWEEN THE LIVE PILLAR AND THE WORKSPACES PILLAR. `ADR 0025` designed it,
 * migration 0006 created the table, `savedFeatureSchema` validated it — and QA finding QV-13
 * found that nothing wrote it, nothing read it, and no control anywhere led to it.
 *
 * ## Why the feature is resolved here, and refused rather than re-fetched
 *
 * The reader arrives with a source slug and a feature id in the query string. Everything else
 * — the coordinates, the observation instant, the label, the credit, the licence — is read
 * from `lib/live/feature-cache.ts`, which holds what the last governed poll returned. Nothing
 * about the feature survives a round trip through the browser (QA finding QV-14).
 *
 * If the cache has forgotten it, this page says so and offers the map. It does **not** go and
 * look: ADR 0025 rejects re-fetching outright, because adsb.lol keeps no history and a
 * re-fetch would return the aircraft's *current* position under the original timestamp. Not
 * old — wrong.
 *
 * ## Why this is its own route rather than a dialog on `/map`
 *
 * A picker listing the reader's own cases needs `auth()`, and `sitemap.md` §10.1 makes "no
 * public route reads the session" a route-level invariant. `/map` is public. A child segment
 * is `force-dynamic` on its own without touching its parent — the same shape
 * `/tools/[slug]/save` uses, so this is that pattern rather than a second one.
 *
 * ## Why the picker is native forms
 *
 * `docs/frontend/HANDOFF-directory.md` §1b: two Server Action versions of the equivalent
 * control were rejected by the E2E suite, each able to drop a save silently — one before
 * hydration, one after. Each case here is a `<form method="post">` to `save/submit`. The
 * whole surface ships no client component and works with the bundle removed.
 *
 * ## It never calls `notFound()`
 *
 * A feature that has aged out of the cache is the *expected* state of this page, not a
 * missing resource, and `/map` has a `loading.tsx` whose Suspense boundary would commit a
 * 200 status before a child's `notFound()` could change it (finding I-15). Both reasons point
 * the same way: render the state, with a control.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = pageMetadata({
  title: "Save a map feature",
  description: "Keep a live map feature in one of your cases.",
  path: "/map/save",
  // Session-dependent and private to one reader. Nothing here belongs in an index.
  index: false,
});

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
 * What is about to be kept, in full, before the reader commits.
 *
 * The observation instant is here because it is the whole value of the row: a saved feature
 * is a claim about a moment (ADR 0025). The credit is here because the licence requires it at
 * the point of display and this is a display. The precision caveat is here because the
 * coordinate above it may be an administrative centroid tens of kilometres from the thing.
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

      {/* The credit sits with the data, not in a footer (ADR 0011 rule 2). */}
      <p className="text-foreground-secondary mt-4 border-t border-border pt-3 text-sm leading-relaxed">
        {resolved.sourceName} · {resolved.attribution.text} · {resolved.attribution.licence}
      </p>
    </section>
  );
}

/**
 * The feature has aged out of the cache.
 *
 * The copy says what is true and what is not: nothing is broken, the source simply does not
 * keep this, and going back to the map is the whole of the fix. It does not offer a retry,
 * because there is nothing to retry.
 */
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

/**
 * `states.md` §6.10's register: say what to do, no apology, and never discard the reader's
 * intent. `callbackUrl` returns them to THIS page, holding the same feature, rather than to
 * the map — landing them one click short of what they came for answers a question they did
 * not ask.
 */
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
    /**
     * First run. `states.md` §0's rule for an empty state — name the next action, do not
     * congratulate and do not scold. The warning about coming back is not decoration: a
     * feature saved ten minutes from now may no longer be in the feed.
     */
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

      {/*
        THE OUTCOME IS ANNOUNCED, and the list stays underneath it — a retry is the same
        button in the same place rather than a trip back through the map. `aria-live` on a
        region that is empty on first render, so a result arriving after a form post is read
        out; a full page load would otherwise announce nothing at all.
      */}
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
                  The workspace id is the ONLY thing the reader chooses, and it is re-checked
                  in SQL against the session user inside the action's transaction. The source
                  and feature ride along because the handler needs to know what was asked
                  for — they are a lookup key into our own cache, not a payload.
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

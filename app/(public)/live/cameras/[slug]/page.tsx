import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, PowerOff } from "lucide-react";

import { CameraEmbed } from "@/components/live/camera-embed";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";
import { getCameraBySlug } from "@/lib/queries/live";
import { isoDay } from "@/components/live/live-format";
import { displayHost, formatDate } from "@/lib/utils";

/**
 * `/live/cameras/[slug]`. sitemap.md §3, ADR 0015, `wireframes/09-live-cameras.txt`.
 *
 * `force-dynamic` and NO OUTBOUND CALL until the reader clicks. The disclosure repeats here
 * rather than relying on the one on the listing, because a detail page can be entered
 * directly — from a search result, a bookmark or somebody else's link — and a reader who
 * never saw the listing has been told nothing.
 *
 * A camera whose connector is switched off still renders in full. The registry row is ours;
 * only the metadata refresh stops (states.md §5.11), and the operator's own page stays
 * authoritative either way.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const camera = await getCameraBySlug(slug);
  if (!camera) {
    return pageMetadata({
      title: "Camera not found",
      description: "This camera is not in the registry.",
      path: `/live/cameras/${slug}`,
      index: false,
    });
  }
  return pageMetadata({
    title: camera.name,
    description: `A camera published by ${camera.operatorName} at ${camera.locationLabel}. Nothing loads until you choose it.`,
    path: `/live/cameras/${camera.slug}`,
  });
}

export default async function CameraDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const camera = await getCameraBySlug(slug);
  if (!camera) notFound();

  /*
   * Camera-level attribution wins over the connector's, and both render. `cameras.attribution`
   * is "the attribution string this feed obliges us to render, if any BEYOND the connector's"
   * (db/schema.ts), so where a camera carries one it is the more specific obligation.
   */
  const attribution = camera.attribution ?? camera.connector?.attribution ?? null;
  const connectorOff = camera.connector !== null && !camera.connector.enabled;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[
          { label: "live", href: "/live" },
          { label: "cameras", href: "/live/cameras" },
          { label: camera.name },
        ]}
      />

      <div className="mt-4">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{camera.name}</h1>
        <p className="mt-1 text-lg text-foreground-secondary">{camera.operatorName}</p>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,40rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          {camera.embedPermitted && camera.embedUrl ? (
            <>
              <CameraEmbed
                embedUrl={camera.embedUrl}
                operatorName={camera.operatorName}
                cameraName={camera.name}
                sourceUrl={camera.sourceUrl}
                attribution={attribution}
              />
              <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
                Loading connects your browser directly to {camera.operatorName}. They will see
                your IP address. We don&rsquo;t proxy or store any image, and we do not record
                that you looked.
              </p>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted p-5 text-center">
                <p className="text-sm text-foreground-secondary">
                  No view is embedded here.
                </p>
              </div>
              <p className="max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
                {camera.operatorName} doesn&rsquo;t permit embedding this view. Opening it takes
                you to their page, where they will see your IP address.
              </p>
              <Button asChild className="h-auto min-h-11 whitespace-normal py-2">
                <a href={camera.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                  <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
                  open on {camera.operatorName}&rsquo;s site
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </Button>
              {camera.embedNotes ? (
                <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
                  {camera.embedNotes}
                </p>
              ) : null}
            </div>
          )}

          {connectorOff ? (
            <Alert variant="info">
              <PowerOff aria-hidden="true" />
              <AlertTitle>This feed&rsquo;s metadata refresh is switched off</AlertTitle>
              <AlertDescription>
                {camera.lastVerifiedAt ? (
                  <>
                    We haven&rsquo;t been able to re-check this feed&rsquo;s details since{" "}
                    <time dateTime={isoDay(camera.lastVerifiedAt)}>
                      {formatDate(camera.lastVerifiedAt)}
                    </time>
                    . The operator&rsquo;s page is authoritative.
                  </>
                ) : (
                  <>
                    We haven&rsquo;t been able to re-check this feed&rsquo;s details. The
                    operator&rsquo;s page is authoritative.
                  </>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div>
          <h2 className="text-xl font-semibold tracking-tight">Registry entry</h2>
          <dl className="mt-4 grid grid-cols-[auto,1fr] gap-x-5 gap-y-3 text-sm">
            <Field label="operator" value={camera.operatorName} />
            <Field label="jurisdiction" value={camera.jurisdiction} />
            <Field label="view kind" value={camera.viewKind} />
            <Field label="location" value={camera.locationLabel} />
            <dt className="text-muted-foreground">coordinates</dt>
            <dd className="font-mono tabular">
              {camera.latitude.toFixed(4)}, {camera.longitude.toFixed(4)}
            </dd>
            {camera.connector ? (
              <>
                <dt className="text-muted-foreground">connector</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  {camera.connector.name}
                  {camera.connector.enabled ? (
                    <Badge variant="success">enabled</Badge>
                  ) : (
                    <Badge variant="muted">switched off</Badge>
                  )}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">source</dt>
            <dd>
              <a
                href={camera.sourceUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="underline underline-offset-4 hover:text-foreground"
              >
                {displayHost(camera.sourceUrl)}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </dl>

          <div className="mt-5 space-y-2">
            <ConfidenceChipLink level={camera.confidence} />
            <VerificationDate lastVerifiedAt={camera.lastVerifiedAt} className="block" />
          </div>

          {camera.embedPermitted && camera.embedNotes ? (
            <div className="mt-6">
              <h3 className="text-base font-semibold tracking-tight">Why embedding is permitted</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
                {camera.embedNotes}
              </p>
            </div>
          ) : null}

          {/*
            Attribution renders here as well as under the image, because the registry entry is
            itself a use of the operator's data. ADR 0011 rule 2 — next to the data, never in
            the footer.
          */}
          {attribution ? (
            <p className="mt-6 border-t border-border pt-4 text-sm font-medium">{attribution}</p>
          ) : null}

          <p className="mt-6 text-sm text-foreground-secondary">
            <Link href="/live" className="underline underline-offset-4 hover:text-foreground">
              How this registry decides what belongs in it
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

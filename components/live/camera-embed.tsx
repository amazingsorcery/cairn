"use client";

import * as React from "react";
import Image from "next/image";
import { ExternalLink, Eye, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MediaPanel } from "@/components/map/media/media-panel";
import { mediaClassFromUrl } from "@/components/map/media/media-kind";
import type { LayerMedia } from "@/components/map/registry/types";
import { formatClockUtc } from "./live-format";

/**
 * A camera view, loaded only on click.
 *
 * - Nothing connects on page load; the image element doesn't exist until the reader asks.
 * - The button label itself says the browser will connect to the operator.
 * - `referrerPolicy="no-referrer"` hides which of our pages the request came from.
 * - No preconnect, dns-prefetch or lazy loading: any of those would connect before the click.
 * - Attribution is shown next to the image (licence requirement).
 *
 * `next/image` is `unoptimized` so the bytes go browser-to-operator instead of through
 * `/_next/image` (we don't proxy third-party imagery). Nothing is logged server-side.
 */

export interface CameraEmbedProps {
  embedUrl: string;
  operatorName: string;
  cameraName: string;
  sourceUrl: string;
  /** Rendered under the image whenever it is shown. Camera-level, then connector-level. */
  attribution: string | null;
}

type EmbedState = "idle" | "loading" | "shown" | "failed";

/**
 * `embedUrl` may be a still, a clip (e.g. TfL JamCam MP4s) or a live stream. Clips and
 * streams go to the same `MediaPanel` the map uses so the wording stays consistent; stills
 * use the `next/image` path below.
 */
export function CameraEmbed(props: CameraEmbedProps) {
  const served = mediaClassFromUrl(props.embedUrl);
  if (served === "video" || served === "stream") {
    return (
      <MediaPanel
        key={props.embedUrl}
        media={movingPictureMedia(props, served)}
        subjectLabel={props.cameraName}
        /* Where a reader whose browser cannot play HLS is sent: the operator's own page. */
        fallbackUrl={props.sourceUrl}
      />
    );
  }
  return <CameraStill {...props} />;
}

/**
 * The `LayerMedia` record for a clip or a live stream on this page.
 *
 * `refreshNote` is `null` because the registry doesn't record one; we don't guess an
 * operator's refresh cadence.
 */
function movingPictureMedia(
  props: CameraEmbedProps,
  served: "video" | "stream",
): LayerMedia {
  const host = new URL(props.embedUrl).host;
  const base = {
    url: props.embedUrl,
    host,
    /* Same disclosure the map panel shows. */
    disclosure:
      `Opening this view connects your browser directly to ${host}, which is ` +
      `${props.operatorName}'s host rather than ours. They will see your IP address and which ` +
      `camera you asked for. We never fetch or re-host it, so nothing passes through us — and ` +
      `we do not record that you looked.`,
    credit: props.attribution,
  };

  return served === "stream"
    ? { ...base, kind: "stream", medium: "video" }
    : { ...base, kind: "video", refreshNote: null };
}

function CameraStill({
  embedUrl,
  operatorName,
  cameraName,
  sourceUrl,
  attribution,
}: CameraEmbedProps) {
  const [state, setState] = React.useState<EmbedState>("idle");
  const [requestedAt, setRequestedAt] = React.useState<string | null>(null);
  /** Forces a fresh element on retry rather than reusing one the browser already failed on. */
  const [attempt, setAttempt] = React.useState(0);

  function load() {
    setRequestedAt(new Date().toISOString());
    setState("loading");
  }

  function retry() {
    setAttempt((n) => n + 1);
    load();
  }

  return (
    <div className="space-y-3">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted">
        {state === "idle" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
            <p className="text-sm text-foreground-secondary">
              Nothing has been requested from {operatorName}.
            </p>
            <Button className="h-auto min-h-11 max-w-full whitespace-normal py-2" onClick={load}>
              <Eye className="size-4 shrink-0" aria-hidden="true" />
              load this view — connects you to {operatorName}
            </Button>
          </div>
        ) : null}

        {state === "failed" ? (
          <div className="flex h-full items-center justify-center p-4">
            <Alert variant="warning" className="text-left">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>This view didn&rsquo;t load</AlertTitle>
              <AlertDescription>
                The connection to {operatorName} failed or the feed has moved. Retry, or open it
                on their site.
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {state === "loading" || state === "shown" ? (
          <Image
            key={attempt}
            src={embedUrl}
            alt={`Camera view: ${cameraName}, published by ${operatorName}`}
            fill
            sizes="(min-width: 768px) 40rem, 100vw"
            /* `eager` because the reader just asked for it; lazy loading could prefetch. */
            unoptimized
            loading="eager"
            referrerPolicy="no-referrer"
            className="object-cover"
            onLoad={() => setState("shown")}
            onError={() => setState("failed")}
          />
        ) : null}
      </div>

      <p aria-live="polite" className="sr-only">
        {state === "loading" ? `Requesting the view from ${operatorName}.` : ""}
        {state === "shown" ? `The view from ${operatorName} loaded.` : ""}
        {state === "failed" ? `The view from ${operatorName} did not load.` : ""}
      </p>

      {state === "shown" && requestedAt ? (
        <p className="tabular text-sm text-foreground-secondary">
          Requested at{" "}
          <time dateTime={requestedAt}>{formatClockUtc(requestedAt)}</time>. How recent the image
          itself is, is {operatorName}&rsquo;s to decide — we neither refresh nor store it.
        </p>
      ) : null}

      {/* Attribution next to the image, not in the footer (TfL and Fintraffic licence terms). */}
      {(state === "shown" || state === "loading") && attribution ? (
        <p className="text-sm font-medium">{attribution}</p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {state === "shown" ? (
          <Button
            variant="secondary"
            className="h-11"
            onClick={() => {
              setState("idle");
              setRequestedAt(null);
            }}
          >
            unload
          </Button>
        ) : null}
        {state === "failed" ? (
          <Button variant="secondary" className="h-11" onClick={retry}>
            retry
          </Button>
        ) : null}
        <Button asChild variant="outline" className="h-auto min-h-11 whitespace-normal py-2">
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            open on {operatorName}&rsquo;s site
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Button>
      </div>
    </div>
  );
}

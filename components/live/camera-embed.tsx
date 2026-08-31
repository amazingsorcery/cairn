"use client";

import * as React from "react";
import Image from "next/image";
import { ExternalLink, Eye, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatClockUtc } from "./live-format";

/**
 * A camera view, loaded only when the reader asks for it. ADR 0015.
 *
 * THE FIVE RULES THIS COMPONENT EXISTS TO KEEP, each of which is one careless edit away from
 * being undone:
 *
 * 1. **Nothing connects on page load.** The placeholder is our own data; the `<img>` element
 *    does not exist until a click. Auto-loading would announce the reader's interest in a
 *    location to its operator before the page had finished painting.
 * 2. **The connection is disclosed before it happens, in plain words**, and the consequence
 *    is in the BUTTON LABEL — not only in a paragraph above it — because the label is the
 *    string the reader actually reads at the moment of deciding.
 * 3. **`referrerPolicy="no-referrer"`**, so the operator learns that someone loaded the image
 *    but not which of our pages they came from.
 * 4. **No `preconnect`, no `dns-prefetch`, no `loading="lazy"`, no thumbnail warming.** Every
 *    performance affordance that opens a connection before an explicit click defeats rule 1,
 *    and "add preconnect for the camera CDN" is exactly the sensible-looking optimisation
 *    that would silently undo this ADR.
 * 5. **Attribution renders wherever the image is shown** (ADR 0011 rule 2). It is a licence
 *    obligation we accepted, not decoration, so it sits next to the image and is not
 *    collapsible.
 *
 * WHY `next/image` WITH `unoptimized`. Optimising it would route the bytes through
 * `/_next/image` on our own origin, which is precisely the proxying ADR 0011 §2 and ADR 0015
 * refuse: it would make us a redistributor of third-party imagery and, where people are in
 * frame, a controller of their image data. `unoptimized` short-circuits the loader entirely,
 * so the rendered `src` is the operator's own URL and the request goes browser-to-operator,
 * with no srcset fan-out and no second request. It also means the component needs no lint
 * exception, which a bare `<img>` would.
 *
 * NOTHING HERE IS LOGGED. This is the reader's own request to a third party; it never touches
 * our server and produces no `connector_requests` row. We genuinely do not know which cameras
 * were viewed (ADR 0015 §6).
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

export function CameraEmbed({
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
            /*
             * `unoptimized` keeps the bytes browser-to-operator; `eager` because the reader
             * has just asked for it and a lazy operator-hosted image is forbidden outright
             * (architecture HANDOFF §9.10); `no-referrer` per ADR 0015 §3.
             */
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

      {/*
        Attribution renders WHEREVER THE IMAGE IS SHOWN, next to the data rather than in a
        page footer. ADR 0011 rule 2, and a licence condition on both TfL's and Fintraffic's
        terms.
      */}
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

"use client";

import * as React from "react";
import { ExternalLink, Image as ImageIcon, PlugZap, Volume2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockUtc } from "@/components/live/live-format";
import type { SourceFeature } from "@/lib/sources/types";
import { featurePrecision, resolveMedia } from "./registry";
import type { LayerMedia, LayerPayloadDto, MapLayerDefinition } from "./registry";
import { SourceLine } from "./layer-status";
import { SaveFeature } from "./save-feature";

/**
 * One feature, in full. Registry-driven: the rows come from `layer.detail`, so this file
 * knows about no source in particular.
 *
 * ## Three things it must always carry
 *
 * 1. **Which source said this**, with a link to the operator, and the attribution its licence
 *    requires — next to the claim, not in a footer.
 * 2. **How old the claim is**, as the observation instant in UTC. Absolute, so two readers
 *    comparing screenshots see the same string.
 * 3. **A link back to the origin record** when the adapter provides one
 *    (`SourceFeature.sourceUrl`). An investigator has to be able to leave here and cite the
 *    primary source; a detail panel that is a dead end is a detail panel that cannot be used
 *    in published work.
 *
 * ## The media block — the thing some layers are actually for
 *
 * A camera the reader cannot look through and a station they cannot hear are both missing the
 * point of their layer. `MapLayerDefinition.media` declares one, this renders it, and the rules
 * it enforces are ADR 0015's and product-brief §2b's rather than this component's:
 *
 * - **Nothing connects until the reader presses the control.** The `<img>` and the `<audio>` do
 *   not exist in the DOM before that. No `preconnect`, no prefetch, no warming — every one of
 *   those is a reasonable-sounding optimisation that silently repeals the decision.
 * - **The connection is disclosed first, in plain words, naming the host**, and the host is
 *   repeated in the control's own label so a reader who reads only the button still learns what
 *   pressing it does. `resolveMedia` refuses a record whose host disagrees with its URL.
 * - **Our server never carries these bytes.** The browser talks to the operator or the
 *   broadcaster directly.
 * - **The credit the licence requires is rendered beside the media**, not in a footer.
 * - **Disconnecting is offered**, because a reader who has finished looking should be able to
 *   stop talking to a third party without leaving the page.
 *
 * ## Focus
 *
 * Opening moves focus to the panel heading, so a keyboard or screen-reader user who
 * activated a table row lands inside what they opened rather than being told nothing
 * happened. Escape closes and returns focus to the element that opened it — the surface owns
 * that half, because it owns the table.
 *
 * It is NOT a modal dialog. A dialog would trap focus and block the map and the table behind
 * it, and the common action after opening a feature is to look at the ones next to it.
 */

export interface FeatureDetailProps<F extends SourceFeature = SourceFeature> {
  layer: MapLayerDefinition<F>;
  feature: F;
  /** The layer's payload, for the source line and the observation instant. */
  payload: Extract<LayerPayloadDto, { ok: true }>;
  onClose: () => void;
  /**
   * Whether this deployment has case workspaces. Required, not defaulted: a new call site
   * must decide, because the wrong default is a button that 404s (ADR 0032).
   */
  signInEnabled: boolean;
}

export function FeatureDetail<F extends SourceFeature>({
  layer,
  feature,
  payload,
  onClose,
  signInEnabled,
}: FeatureDetailProps<F>) {
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);

  React.useEffect(() => {
    headingRef.current?.focus();
  }, [feature.id]);

  const precision = featurePrecision(layer, feature);
  const media = resolveMedia(layer, feature);

  const rows = layer.detail
    .map((row) => ({ label: row.label, value: row.value(feature), mono: row.mono ?? false }))
    .filter((row): row is { label: string; value: string; mono: boolean } => row.value !== null);

  return (
    <section
      aria-labelledby="map-feature-detail-heading"
      className="rounded-lg border border-border bg-card p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{layer.label}</p>
          <h2
            id="map-feature-detail-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-0.5 text-lg font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {feature.label}
          </h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">close the {layer.label.toLowerCase()} detail</span>
        </Button>
      </div>

      {/*
        A description list, not a table. These are label/value pairs about one thing, which
        is what `<dl>` is for; a two-column table here would announce a column header on
        every row.
      */}
      <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</dt>
            <dd className={row.mono ? "font-mono text-sm break-words" : "text-sm break-words"}>
              {row.value}
            </dd>
          </div>
        ))}
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Position</dt>
          <dd className="font-mono tabular text-sm">
            {feature.latitude.toFixed(4)}, {feature.longitude.toFixed(4)}
            {feature.altitude === undefined ? null : ` · ${Math.round(feature.altitude)} m`}
          </dd>
          {/*
            THE CAVEAT SITS UNDER THE NUMBER IT QUALIFIES, in full sentences, not as a badge.
            A reader who is about to write "the warning is at 32.2N, 110.9W" needs to be told
            here that the coordinate is an administrative centroid — a footnote elsewhere on
            the page is a caveat nobody carries into their notes. `layer.precision` is a
            registry field; this panel knows about no layer in particular.
          */}
          {precision ? (
            <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">
              <span className="font-semibold text-foreground">Approximate position.</span>{" "}
              {precision.note}
            </p>
          ) : null}
        </div>
      </dl>

      {media ? (
        /*
          KEYED ON THE FEATURE so that selecting a different camera or station starts closed
          again. Without the key React keeps the state of the component in this position, and
          opening one camera would connect the reader to the next one they clicked without
          asking — the auto-load ADR 0015 forbids, arrived at through a state bug.
        */
        <FeatureMedia key={feature.id} media={media} featureLabel={feature.label} />
      ) : null}

      {feature.sourceUrl ? (
        <p className="mt-4">
          <a
            href={feature.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            open this record at {payload.source.name}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      ) : null}

      {/*
        SAVE, UNDER THE FACTS AND ABOVE THE SOURCE LINE.

        It sits after everything that describes the feature and before the credit, because a
        reader decides to keep something once they have read what it is. It is a plain GET
        form to a session-gated route — see `save-feature.tsx` for why it is not a button
        calling a Server Action, and why nothing but the source slug and the feature id
        crosses the wire.
      */}
      {/*
        SAVE TO A CASE. Rendered for signed-out readers too — the picker handles that state and
        sends them to sign-in and back. Not rendered when this deployment has no sign-in at
        all: `/map/save` is not served then, and the reader has nowhere to be sent.
      */}
      {signInEnabled ? <SaveFeature layer={layer} feature={feature} /> : null}

      <div className="mt-4 border-t border-border pt-3 text-sm text-foreground-secondary">
        <p className="tabular">
          Observed{" "}
          <time dateTime={payload.observedAt}>{formatClockUtc(payload.observedAt)}</time>.
        </p>
        <SourceLine source={payload.source} />
      </div>
    </section>
  );
}

/**
 * One feature's picture or audio: disclosed, then loaded only if the reader says so.
 *
 * Three kinds, and the third is not a lesser version of the other two. A plain-`http:` stream
 * cannot play inside a secure page — the browser blocks it and says nothing — so offering a
 * play button for one would be offering a control that does nothing. It gets a link instead,
 * which is the same connection the reader would have made, in the form their browser will
 * honour. About a fifth of the radio catalogue is in that state.
 */
function FeatureMedia({ media, featureLabel }: { media: LayerMedia; featureLabel: string }) {
  const [open, setOpen] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  /*
   * FOCUS DOES NOT FALL ON THE FLOOR WHEN A CONTROL REPLACES ITSELF.
   *
   * Pressing "load" removes the button that was focused and pressing "disconnect" removes that
   * one, so without this a keyboard reader is dropped onto `<body>` mid-panel and a screen
   * reader announces nothing at all — which reads as the control having failed. Focus moves to
   * whichever control took the other's place, and that announcement doubles as confirmation
   * that the press did something. Same rule the panel already follows when it closes.
   *
   * Only after a press: `moved` is set in the handlers, never on first render, so opening the
   * panel does not steal focus from the heading.
   */
  const loadRef = React.useRef<HTMLButtonElement | null>(null);
  const disconnectRef = React.useRef<HTMLButtonElement | null>(null);
  const moved = React.useRef(false);

  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    if (open) disconnectRef.current?.focus();
    else loadRef.current?.focus();
  }, [open]);

  return (
    <section
      aria-label={`Media from ${media.host}`}
      className="mt-4 rounded-md border border-dashed border-border p-3"
    >
      {/*
        THE DISCLOSURE IS ABOVE THE CONTROL AND STAYS THERE. A reader deciding whether to reveal
        their address to a camera operator has to be able to read the consequence before acting,
        and to re-read it afterwards without undoing anything. ADR 0015 point 2.
      */}
      <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
        {media.disclosure}
      </p>

      {media.kind === "link" ? (
        <p className="mt-3">
          <a
            href={media.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium underline underline-offset-4 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            open the stream at {media.host}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      ) : !open ? (
        <Button
          ref={loadRef}
          variant="secondary"
          className="mt-3 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
          onClick={() => {
            moved.current = true;
            setFailed(false);
            setOpen(true);
          }}
        >
          {media.kind === "image" ? (
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Volume2 className="size-4 shrink-0" aria-hidden="true" />
          )}
          {/* The consequence is IN the label, not only in the paragraph above it. */}
          {media.kind === "image" ? "load the image" : "play"} — connects you directly to{" "}
          {media.host}
        </Button>
      ) : (
        <div className="mt-3">
          {failed ? (
            <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
              {media.host} did not answer, or sent something this browser will not
              {media.kind === "image" ? " display" : " play"}. That exchange was between your
              browser and them; nothing here is broken and nothing passed through this site.
            </p>
          ) : media.kind === "image" ? (
            /*
              A PLAIN `<img>`, DELIBERATELY.

              `next/image` would route these bytes through our own optimiser, which is exactly
              the relaying ADR 0015 and product-brief §2b forbid: it would make this site a
              redistributor of an operator's imagery and put their traffic on our bandwidth.
              `referrerPolicy="no-referrer"` so the operator learns that somebody loaded the
              image but not which of our pages they were on (ADR 0015 point 3).
            */
            // eslint-disable-next-line @next/next/no-img-element -- next/image proxies the bytes through our server, which is the redistribution ADR 0015 forbids. This must be a direct browser-to-operator request.
            <img
              src={media.url}
              alt={`Image from ${featureLabel}, loaded from ${media.host}. Nothing here describes what it shows.`}
              referrerPolicy="no-referrer"
              onError={() => setFailed(true)}
              className="max-h-[60vh] w-full rounded-md border border-border object-contain"
            />
          ) : (
            /*
              NO CAPTION TRACK, and it is worth saying why rather than leaving a gap: a live
              radio stream has none to offer and we will not invent one. The station's name,
              language, country and homepage are in the panel above, which is the text
              equivalent a reader who cannot hear it actually gets. `jsx-a11y/media-has-caption`
              is not enabled in this repo's config, so there is no directive to leave here — a
              disable comment for a rule that is off is itself a lint warning.
            */
            <audio
              src={media.url}
              controls
              autoPlay
              /* `none` matters even here: without it some browsers refetch on mount. */
              preload="none"
              onError={() => setFailed(true)}
              className="w-full"
            >
              Your browser cannot play this stream.
            </audio>
          )}

          {/*
            THE CREDIT SITS WITH THE MEDIA, because that is what the licence asks for. TfL's
            wording carries the Ordnance Survey notice and CC BY carries Fintraffic's; neither
            is satisfied by a line in a footer. Null means the licence asks for nothing, which
            is true of a public-domain dedication and false of everything else here.
          */}
          {media.credit && !failed ? (
            <p className="mt-2 max-w-[68ch] text-xs leading-relaxed text-foreground-secondary">
              {media.credit}
            </p>
          ) : null}

          <Button
            ref={disconnectRef}
            variant="ghost"
            className="mt-2 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
            onClick={() => {
              moved.current = true;
              setOpen(false);
              setFailed(false);
            }}
          >
            <PlugZap className="size-4 shrink-0" aria-hidden="true" />
            {/* Unmounting the element is what actually ends the connection. */}
            disconnect from {media.host}
          </Button>
        </div>
      )}
    </section>
  );
}

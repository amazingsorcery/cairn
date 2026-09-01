"use client";

import * as React from "react";
import { ExternalLink, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockUtc } from "@/components/live/live-format";
import type { SourceFeature } from "@/lib/sources/types";
import { MediaPanel } from "./media/media-panel";
import { featurePrecision, resolveMedia } from "./registry";
import type { LayerPayloadDto, MapLayerDefinition } from "./registry";
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
 * point of their layer. `MapLayerDefinition.media` declares one and `media/media-panel.tsx`
 * renders it — the panel lives there rather than here because `/live/cameras/[slug]` renders the
 * same thing, and two copies of a component whose whole job is stating precisely what a
 * connection does would drift on exactly the wording that matters.
 *
 * Everything it enforces — click-to-load, the disclosure naming the host, no proxying, the
 * credit beside the media, a disconnect control, and the refusal to call a periodically replaced
 * clip "live" — is ADR 0015's and product-brief §2b's, and is documented in that file and in
 * `docs/frontend/HANDOFF-map.md` §2.2.
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
        <MediaPanel
          key={feature.id}
          media={media}
          subjectLabel={feature.label}
          /*
            Where a reader whose browser cannot play a live stream is sent. It is the adapter's
            own origin record — the operator's page — rather than the manifest URL, because a
            browser handed an `.m3u8` will usually download it instead of playing it.
          */
          fallbackUrl={feature.sourceUrl ?? null}
        />
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

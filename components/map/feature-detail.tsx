"use client";

import * as React from "react";
import { ExternalLink, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatClockUtc } from "@/components/live/live-format";
import type { SourceFeature } from "@/lib/sources/types";
import type { LayerPayloadDto, MapLayerDefinition } from "./registry";
import { SourceLine } from "./layer-status";

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
}

export function FeatureDetail<F extends SourceFeature>({
  layer,
  feature,
  payload,
  onClose,
}: FeatureDetailProps<F>) {
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);

  React.useEffect(() => {
    headingRef.current?.focus();
  }, [feature.id]);

  const precision = layer.precision?.(feature) ?? null;

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

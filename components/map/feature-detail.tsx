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
 * Detail panel for one feature. Rows come from `layer.detail`, so it's source-agnostic.
 *
 * Always shows the source and its attribution, the observation time in UTC, and a link to
 * the origin record when the adapter provides one. Media (camera/stream/radio) is rendered by
 * `media/media-panel.tsx`, shared with `/live/cameras/[slug]`.
 *
 * Opening focuses the heading; Escape closes (the surface restores focus). Not a modal, so
 * the map and table stay usable.
 */

export interface FeatureDetailProps<F extends SourceFeature = SourceFeature> {
  layer: MapLayerDefinition<F>;
  feature: F;
  /** The layer's payload, for the source line and the observation instant. */
  payload: Extract<LayerPayloadDto, { ok: true }>;
  onClose: () => void;
  /** Whether this deployment has case workspaces. Required so callers can't default into a 404. */
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

      {/* Label/value pairs, so `<dl>` rather than a table. */}
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
          {/* Precision caveat (e.g. administrative centroid) directly under the coordinate. */}
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
          Keyed on the feature so selecting another one starts closed, instead of carrying
          "open" state over and auto-connecting.
        */
        <MediaPanel
          key={feature.id}
          media={media}
          subjectLabel={feature.label}
          /* Operator's page, not the `.m3u8`, which browsers tend to download instead of play. */
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
        Save to a case (see `save-feature.tsx`). Shown to signed-out readers too; hidden when
        the deployment has no sign-in, since `/map/save` isn't served then.
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

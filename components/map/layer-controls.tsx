"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import type { LayerPayloadDto, MapLayerDefinition, Rgba } from "./registry";
import { cssColour } from "./registry/palette";

/**
 * The layer switches, and the legend, as one thing.
 *
 * ## Why the legend is not a separate box
 *
 * A legend in a corner and a toggle list in a panel say the same thing twice and drift apart
 * the first time someone changes a colour. Here the swatch IS the legend: it sits in the row
 * that turns the layer on, drawn from the same literal RGBA the WebGL canvas uses
 * (`registry/palette.ts`), so the dot beside the label and the dot on the map cannot disagree.
 *
 * ## Registry-driven
 *
 * One row per `MAP_LAYERS` entry. This component names no layer. Adding a source adds a row.
 *
 * ## Keyboard and touch
 *
 * A real `<fieldset>` with a `<legend>`, and a real `<input type="checkbox">` per layer — so
 * a screen reader announces "Layers, group" and then "Earthquakes, checkbox, checked", and
 * the whole set is reachable with Tab and operated with Space. No pointer is required and no
 * ARIA is invented, because the native controls already say all of it.
 *
 * The whole row is the label, so the touch target is the row rather than the 16px box, and
 * the row is `min-h-11`. On a phone this panel sits directly beneath the map — in the
 * bottom half of the screen, inside thumb reach — rather than in a drawer that needs a
 * two-step open.
 */

export interface LayerControlsProps {
  layers: readonly MapLayerDefinition[];
  payloads: Readonly<Record<string, LayerPayloadDto | undefined>>;
  visible: ReadonlySet<string>;
  onToggle: (layerId: string, next: boolean) => void;
  theme: "dark" | "light";
  className?: string;
}

export function LayerControls({
  layers,
  payloads,
  visible,
  onToggle,
  theme,
  className,
}: LayerControlsProps) {
  return (
    <fieldset className={cn("rounded-lg border border-border bg-card p-3", className)}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Layers
      </legend>
      <ul className="mt-1">
        {layers.map((layer) => (
          <li key={layer.id}>
            <LayerRow
              layer={layer}
              payload={payloads[layer.id]}
              checked={visible.has(layer.id)}
              onToggle={onToggle}
              colour={theme === "dark" ? layer.colour.dark : layer.colour.light}
            />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function LayerRow({
  layer,
  payload,
  checked,
  onToggle,
  colour,
}: {
  layer: MapLayerDefinition;
  payload: LayerPayloadDto | undefined;
  checked: boolean;
  onToggle: (layerId: string, next: boolean) => void;
  colour: Rgba;
}) {
  const inputId = `map-layer-${layer.id}`;
  const descriptionId = `${inputId}-description`;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2",
        "hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        "motion-reduce:transition-none",
      )}
    >
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(layer.id, event.target.checked)}
        aria-describedby={descriptionId}
        className="mt-1 size-5 shrink-0 accent-[var(--primary-solid)] focus-visible:outline-none"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {/*
            The swatch is `aria-hidden`: it repeats the layer name for a sighted reader and
            says nothing new to a screen reader, which already has the label. Colour is never
            the only signal — the label is the signal and the swatch is the shortcut.
          */}
          <Swatch colour={colour} symbol={layer.legend.symbol} />
          <span className="font-medium">{layer.label}</span>
          <LayerCount payload={payload} />
        </span>
        <span id={descriptionId} className="mt-0.5 block text-xs text-foreground-secondary">
          {layer.legend.note ? `${layer.description} ${layer.legend.note}` : layer.description}
        </span>
      </span>
    </label>
  );
}

/**
 * The count, or the one-word state.
 *
 * A layer that failed shows "unavailable" here and its full sentence beside its table. The
 * word is enough in a control row; the reason belongs where the reader went looking for the
 * data. What it never shows is a blank, which would read as zero features rather than as no
 * answer.
 */
function LayerCount({ payload }: { payload: LayerPayloadDto | undefined }) {
  if (!payload) {
    return <span className="text-xs text-muted-foreground">not loaded</span>;
  }
  if (!payload.ok) {
    return <span className="text-xs font-medium text-destructive">unavailable</span>;
  }
  return (
    <span className="tabular text-xs text-muted-foreground">
      {new Intl.NumberFormat("en-GB").format(payload.features.length)}
      {payload.stale ? " · stale" : ""}
    </span>
  );
}

function Swatch({ colour, symbol }: { colour: Rgba; symbol: "circle" | "graduated" }) {
  const fill = cssColour(colour);
  if (symbol === "graduated") {
    /* Three sizes, because the size means something on this layer and one dot cannot say so. */
    return (
      <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: fill }} />
        <span className="size-2.5 rounded-full" style={{ backgroundColor: fill }} />
        <span className="size-3.5 rounded-full" style={{ backgroundColor: fill }} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="size-3 shrink-0 rounded-full"
      style={{ backgroundColor: fill }}
    />
  );
}

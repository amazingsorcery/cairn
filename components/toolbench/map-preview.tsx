"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Map as MapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mapTiles } from "@/config/live";
import type { PointMapProps } from "./point-map";

/**
 * The click gate in front of the map.
 *
 * ADR 0015 and the product brief's streaming rule land in the same place: an embed loads when
 * the reader asks for it, not before. On a coordinate tool the argument is sharper than usual
 * — the tiles are requested from a third party, and the tiles you request *are* the coordinate
 * you are investigating. A reader who converts a grid reference and never opens the map has
 * disclosed nothing to anyone.
 *
 * The consequence is IN the button label rather than only in the prose above it (ADR 0015 §2),
 * and the host is read from `config/live.ts` so it cannot drift away from the origin the CSP
 * and the map itself actually use.
 *
 * MapLibre is also by a wide margin the largest dependency in the product. `next/dynamic` with
 * `ssr: false`, rendered only once `shown` is true, puts it in an async chunk that is fetched
 * on the click and never enters the bundle of a route that draws no map.
 */

const PointMap = dynamic<PointMapProps>(() => import("./point-map"), {
  ssr: false,
  loading: () => <Skeleton className="h-[22rem] w-full" />,
});

/** `tiles.openfreemap.org`. Named in the label, never hardcoded. */
const TILE_HOST = new URL(mapTiles.origin).host;

export function MapPreview(props: PointMapProps) {
  const [shown, setShown] = React.useState(false);

  if (!shown) {
    return (
      <div className="flex h-[22rem] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center">
        <MapIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-[42ch] text-sm leading-relaxed text-muted-foreground">
          The map is not loaded. Opening it requests tiles from {TILE_HOST}, which will see your
          IP address and the tiles you ask for — which is to say, the coordinate you are looking
          at. Everything above this box was computed in your browser and sent nowhere.
        </p>
        {/*
          `whitespace-normal` and `h-auto`: the label carries the consequence, so it is long,
          and at 375px a nowrap button would push the page into a horizontal scroll. The label
          is not shortened to fit — the consequence being in the label is the point.
        */}
        <Button
          type="button"
          className="h-auto min-h-11 max-w-full whitespace-normal py-2"
          onClick={() => setShown(true)}
        >
          show this point on a map — connects you to {TILE_HOST}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <PointMap {...props} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Tiles are being requested from {TILE_HOST}.
        </p>
        {/*
          Unmounting the map stops the requests without a page reload, which on these tools
          would throw away the reader's input.
        */}
        <Button variant="ghost" size="lg" onClick={() => setShown(false)}>
          hide the map
        </Button>
      </div>
    </div>
  );
}

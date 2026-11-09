"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Map as MapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mapTiles } from "@/config/live";
import type { PointMapProps } from "./point-map";

/**
 * Click gate in front of the map. The tiles requested reveal the coordinate being looked at,
 * so nothing loads until the reader asks; the button label names the tile host (read from
 * `config/live.ts` so it matches the CSP).
 *
 * MapLibre is large, so it's loaded via `next/dynamic` (`ssr: false`) only after the click.
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
        {/* The label is long; wrap it so it doesn't cause horizontal scroll on phones. */}
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
        {/* Unmounting stops tile requests without a reload (which would lose input). */}
        <Button variant="ghost" size="lg" onClick={() => setShown(false)}>
          hide the map
        </Button>
      </div>
    </div>
  );
}

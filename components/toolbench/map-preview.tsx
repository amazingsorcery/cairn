"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Map as MapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { PointMapProps } from "./point-map";

/**
 * The click gate in front of the map.
 *
 * ADR 0015 and the product brief's streaming rule both land in the same place: an embed is
 * loaded when the reader asks for it, not before. On a coordinate tool the argument is
 * sharper than usual — the map tiles are requested from a third party, and the tiles you
 * request *are* the coordinate you are investigating. A reader who converts a grid reference
 * and never opens the map has disclosed nothing to anyone.
 *
 * The map code and Leaflet's CSS (about 42 KB) are also only downloaded on that click, so a
 * reader who never opens a map never pays for one.
 */

const PointMap = dynamic<PointMapProps>(() => import("./point-map"), {
  ssr: false,
  loading: () => <Skeleton className="h-[22rem] w-full" />,
});

export function MapPreview(props: PointMapProps) {
  const [shown, setShown] = React.useState(false);

  if (!shown) {
    return (
      <div className="flex h-[22rem] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center">
        <MapIcon className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-[42ch] text-sm leading-relaxed text-muted-foreground">
          The map is not loaded. Opening it requests tiles from OpenStreetMap, which means
          telling a third party which coordinate you are looking at.
        </p>
        <Button type="button" variant="secondary" size="lg" onClick={() => setShown(true)}>
          Show this point on a map
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <PointMap {...props} />
      <p className="text-xs text-muted-foreground">
        Tiles are being requested from OpenStreetMap. Reload the page to stop.
      </p>
    </div>
  );
}

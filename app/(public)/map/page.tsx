import { headers } from "next/headers";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { MapSurface } from "@/components/map/map-surface";
import {
  MAP_LAYERS,
  defaultVisibleLayerIds,
  layerQuery,
  type LayerPayloadDto,
} from "@/components/map/registry";
import { ageSeconds } from "@/components/live/live-format";
import { pageMetadata } from "@/lib/metadata";
import { isSignInEnabled } from "@/lib/session-surface";
import { clientSubjectFromHeaders, consumeSafely } from "@/lib/rate-limit";
import { buildLayerPayload } from "./payloads";

/**
 * `/map`: the live map. `force-dynamic` so only payloads are cached (one clock for data age).
 *
 * Every layer is fetched server-side so the tables are in the initial HTML and work without
 * JS or WebGL. `buildLayerPayload` never throws, so one failing source can't break the page.
 * No session read: every viewer gets the same shared cache entry.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = pageMetadata({
  title: "Map",
  description:
    "Independently toggleable layers of live public data on one map, each labelled with its source, its licence and how old it is. Every layer is also a sortable table that works without the map.",
  path: "/map",
});

/** Whole-world opening view. Zoom 1.4 fits populated latitudes on a 375px screen. */
const INITIAL_VIEW = { longitude: 0, latitude: 20, zoom: 1.4 } as const;

/**
 * Server-side fetch bounds, matching `INITIAL_VIEW`. Global feeds ignore it; viewport-scoped
 * sources turn it into a bbox. Client refreshes send the real viewport.
 */
const INITIAL_BOUNDS = { west: -180, south: -85, east: 180, north: 85 } as const;

export default async function MapPage() {
  /*
   * Per-client limit, consumed once per render rather than per layer (per-layer would cost
   * more DB writes than it saves). The client address is HMACed before storage.
   */
  const budget = await consumeSafely("map-layer", clientSubjectFromHeaders(await headers()));

  const payloads = budget.ok
    ? await Promise.all(
        MAP_LAYERS.map((layer) => buildLayerPayload(layer, layerQuery(layer, INITIAL_BOUNDS))),
      )
    : /*
       * Over the limit: still render, with each layer explaining it, rather than a bare 429
       * (the reader may be behind a large NAT). `quotaExhausted` because we refused, not the
       * upstream.
       */
      MAP_LAYERS.map(
        (layer): LayerPayloadDto => ({
          layerId: layer.id,
          source: null,
          ok: false,
          failure: { kind: "quotaExhausted", resetsAt: budget.resetAt },
          lastGoodAt: null,
        }),
      );

  const byId: Record<string, LayerPayloadDto> = {};
  const ages: Record<string, number | null> = {};
  const now = Date.now();
  for (const payload of payloads) {
    byId[payload.layerId] = payload;
    ages[payload.layerId] = payload.ok ? ageSeconds(payload.observedAt, now) : null;
  }

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb items={[{ label: "map" }]} />

      <div className="mt-4 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Map</h1>
        <p className="mt-3 text-lg text-foreground-secondary">
          Layers of data that operators have chosen to publish, each one switchable on its own
          and labelled with where it came from and how old it is. The map is optional: every
          layer below is also a sortable table with the same features in it.
        </p>
      </div>

      <div className="mt-8">
        <MapSurface
          initialPayloads={byId}
          initialAges={ages}
          initialVisible={defaultVisibleLayerIds()}
          initialView={INITIAL_VIEW}
          signInEnabled={isSignInEnabled()}
        />
      </div>

      <section
        aria-labelledby="map-caveats-heading"
        className="mt-12 max-w-[68ch] border-t border-border pt-6"
      >
        <h2 id="map-caveats-heading" className="text-xl font-semibold tracking-tight">
          How to read this map
        </h2>
        <ul className="mt-3 space-y-3 text-base leading-relaxed text-foreground-secondary">
          <li>
            <strong className="text-foreground">Absence is not evidence.</strong> Every layer
            covers what its source publishes and no more. A feature missing from this map is
            not a finding; it is a gap in somebody&rsquo;s coverage until you have checked
            which.
          </li>
          <li>
            <strong className="text-foreground">Each layer states its own age.</strong> Live
            data is out of date the instant it is fetched, so each layer says how old what you
            are looking at is, and shows nothing rather than something past its horizon.
          </li>
          <li>
            <strong className="text-foreground">One dead source is one dead layer.</strong> A
            source that fails disables itself and says why. Nothing else on the page changes.
          </li>
          <li>
            <strong className="text-foreground">The tables are the equivalent, not a
            fallback.</strong> They carry every feature the map draws, sortable, with a link
            back to each record at its origin — and they never start WebGL.
          </li>
        </ul>
      </section>
    </div>
  );
}

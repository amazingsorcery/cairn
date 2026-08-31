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
import { buildLayerPayload } from "./payloads";

/**
 * `/map` — the live map. Product-brief §2a pillar A.
 *
 * `force-dynamic`, for the reason ADR 0014 §5 gives: the route HTML is never in the Full
 * Route Cache. Only the fetched payload is cached, so there is exactly one clock telling the
 * reader how old the data is. Two cache layers with independent clocks disagreeing about the
 * age would be wrong on the one number that matters most on this page.
 *
 * ## Every layer is fetched here, on the server, and the tables are in the initial HTML
 *
 * The map is opt-in and WebGL never has to start. That is only true if the data arrives
 * without it, so the page fetches every registry layer, converts each to a DTO and hands them
 * to the surface. A reader with JavaScript off gets complete, sorted tables with sources,
 * ages and links back to origin — which is the product working, not a degraded mode.
 *
 * ## One failing source does not fail the page
 *
 * `Promise.all` over `buildLayerPayload`, which returns a failure DTO rather than throwing.
 * A rejected promise here would take out every other layer, which is exactly what
 * product-brief §2b forbids.
 *
 * ## No session read
 *
 * `sitemap.md` §10.1 makes that a route-level invariant for public routes, and nothing on
 * this page differs per reader. Every viewer is served the same payload from one shared
 * cache entry, which is also what keeps us inside each upstream's fair use and means the
 * cache key cannot encode who asked (ADR 0014 §4).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = pageMetadata({
  title: "Map",
  description:
    "Independently toggleable layers of live public data on one map, each labelled with its source, its licence and how old it is. Every layer is also a sortable table that works without the map.",
  path: "/map",
});

/**
 * The opening view: the whole world, centred on the prime meridian at the equator.
 *
 * Deliberately not a city. A default centred on London or San Francisco tells a reader whose
 * map this is before they have looked at it, and several of these layers are global. Zoom 1.4
 * fits the populated latitudes on a 375px screen without cropping the Pacific.
 */
const INITIAL_VIEW = { longitude: 0, latitude: 20, zoom: 1.4 } as const;

/**
 * The bounds the server fetches for. The whole world, matching `INITIAL_VIEW`.
 *
 * Every layer is handed this and the registry decides what to do with it: a global feed
 * ignores it, a viewport-scoped source turns it into a bounding box (`layerQuery`). The
 * server cannot know where the reader will pan to, so it answers for the view it is about to
 * render and the client's refresh sends the real one.
 */
const INITIAL_BOUNDS = { west: -180, south: -85, east: 180, north: 85 } as const;

export default async function MapPage() {
  const payloads = await Promise.all(
    MAP_LAYERS.map((layer) => buildLayerPayload(layer, layerQuery(layer, INITIAL_BOUNDS))),
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

import type { SourceQuery } from "@/lib/sources/types";
import type { MapLayerDefinition, MapViewport } from "./types";
import { earthquakesLayer } from "./earthquakes";
import { stressLayer } from "./stress";
import { weatherAlertsLayer } from "./weather";

export type {
  DeckKit,
  DeckLayerFactory,
  DeckLayerInput,
  DetailRow,
  FeaturePrecision,
  LayerColour,
  LayerPayloadDto,
  LayerSourceDto,
  LegendEntry,
  MapLayerDefinition,
  MapViewport,
  Rgba,
  SortDirection,
  TableColumn,
  TableSort,
} from "./types";

/**
 * THE LAYER REGISTRY.
 *
 * Adding a source to the map is: write one file in this directory, add it to the array
 * below, and register its adapter in `app/(public)/map/adapters.ts`. **No component in
 * `components/map/` changes.** That is the whole design, and `registry.test.ts` enforces it
 * by failing if any component outside this directory contains a layer id.
 *
 * Order is display order, in the layer list and in the legend. It is also the deck.gl draw
 * order, so later entries paint over earlier ones — put dense background layers first.
 *
 * This module has **no runtime import of deck.gl or MapLibre**. Every entry's `deck` field
 * is a factory that receives its constructors (see `types.ts`), so the table, the legend and
 * the toggles can read the registry with no WebGL loaded at all — which is what makes the
 * table a genuine equivalent rather than a fallback.
 */
const ALL_LAYERS: readonly MapLayerDefinition[] = [
  earthquakesLayer,
  weatherAlertsLayer,
  stressLayer,
];

/**
 * `devOnly` entries are dropped from a production build.
 *
 * `process.env.NODE_ENV` is inlined by the bundler, so this is a build-time constant and the
 * dev layer's module is dropped from the production chunk rather than merely hidden.
 */
export const MAP_LAYERS: readonly MapLayerDefinition[] = ALL_LAYERS.filter(
  (layer) => !layer.devOnly || process.env.NODE_ENV !== "production",
);

const BY_ID = new Map(MAP_LAYERS.map((layer) => [layer.id, layer]));

/** The layer with this id, or null. Null rather than throwing: an unknown id in a URL
 * fragment or a stale bookmark must not render an error page. */
export function findLayer(id: string): MapLayerDefinition | null {
  return BY_ID.get(id) ?? null;
}

/** Ids of the layers that are on when the map first opens. */
export function defaultVisibleLayerIds(): readonly string[] {
  return MAP_LAYERS.filter((layer) => layer.defaultVisible).map((layer) => layer.id);
}

/**
 * What to ask a layer's source for, given the viewport.
 *
 * A layer with no `query` gets `{}` — the whole feed. This exists so the CALLER never has to
 * know which layers are viewport-scoped: it hands every layer the viewport and the registry
 * decides what, if anything, to do with it.
 */
export function layerQuery(layer: MapLayerDefinition, viewport: MapViewport): SourceQuery {
  return layer.query ? layer.query(viewport) : {};
}

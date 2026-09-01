import type { PositionalPrecision, SourceFeature, SourceQuery } from "@/lib/sources/types";
import { mediaClassFromUrl } from "../media/media-kind";
import type { LayerMedia, MapLayerDefinition, MapViewport } from "./types";
import { aircraftLayer } from "./aircraft";
import { camerasLayer } from "./cameras";
import { earthquakesLayer } from "./earthquakes";
import { radioLayer } from "./radio";
import { stressLayer } from "./stress";
import { weatherAlertsLayer } from "./weather";
import { wildfiresLayer } from "./wildfires";

export type {
  DeckKit,
  LayerMedia,
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
 * below, and make sure `lib/sources/index.ts` exports an adapter whose slug matches `sourceSlug`. **No component in
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
  /*
   * Densest first, sparsest last, because this is the deck.gl draw order and later entries
   * paint over earlier ones. A global day of FIRMS detections and a busy patch of airspace can
   * be tens of thousands of dots between them; there are ten cameras and a few dozen
   * earthquakes. Drawing the sparse layers last keeps the features a reader is most likely to
   * want to open on top of the ones they are most likely to be looking through — and picking
   * follows the same order, so a camera under a fire detection is still clickable.
   */
  wildfiresLayer,
  aircraftLayer,
  radioLayer,
  weatherAlertsLayer,
  earthquakesLayer,
  camerasLayer,
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

/**
 * The positional caveat for one feature: **the adapter's, if it set one; the layer's
 * derivation otherwise.**
 *
 * `PositionalPrecision` is now on `SourceFeature`, which is the right home — a source knows
 * best how well it located a thing, and putting it there means the caveat survives into a
 * workspace snapshot and an export rather than living only in a map component. Adapters are
 * adopting it; until one has, the layer's own `precision` derives it from the properties that
 * source publishes (NWS's `locationBasis`, for instance).
 *
 * Order matters and is not arbitrary: the adapter wins, because when both exist the adapter
 * is the one with the upstream in front of it. The layer function is a bridge, not a
 * competitor, and it should be deleted from a layer once its adapter sets the field.
 */
export function featurePrecision<F extends SourceFeature>(
  layer: MapLayerDefinition<F>,
  feature: F,
): PositionalPrecision | null {
  return feature.precision ?? layer.precision?.(feature) ?? null;
}

/**
 * The media a feature offers, **validated**, or null.
 *
 * `feature-detail.tsx` calls this and never `layer.media` directly, because three of the four
 * checks below cannot be left to the layer that produced the record.
 *
 * 1. **The URL must parse and carry a protocol we will actually render.** Everything embedded
 *    is `https:` only — a plain-http subresource is blocked as mixed content by any browser on
 *    this page, so rendering one would produce a control that fails silently, which is the
 *    exact failure the `link` kind exists to avoid. `link` accepts `http:` too, because there
 *    it is a top-level navigation the browser will honour. Nothing else is accepted at all:
 *    these URLs come from a community-edited catalogue, and `javascript:` in an `href` is one
 *    of the oldest holes there is.
 * 2. **`host` must be the host of `url`.** The disclosure names a host to the reader and the
 *    control's own label repeats it. If the two could drift, this product would be telling
 *    someone they are about to contact one operator while their browser contacts another —
 *    a specific false assurance, which is worse than saying nothing.
 * 3. **`kind` must not contradict what the URL plainly serves.** The same rule as (2), applied
 *    to the second claim a record makes to the reader. An `<img>` pointed at an `.mp4` draws a
 *    broken-image glyph; an `<audio>` pointed at an `.m3u8` plays nothing outside Safari and
 *    says nothing anywhere; a periodically replaced clip declared `stream` tells an
 *    investigator that a five-minute-old picture is the road as it is now. `mediaClassFromUrl`
 *    only ever contradicts — an extensionless or unfamiliar URL establishes nothing and the
 *    declared kind stands. `link` is exempt, because a link may legitimately point at anything.
 * 4. A layer that throws while building a record disables its own media rather than the panel.
 *
 * **A refusal is a build-time failure, not a reader-facing one.** `contract.test.ts` asserts
 * that every camera and every playable station still yields media, so a record that starts
 * contradicting itself fails CI rather than quietly losing its control on a live page.
 *
 * Returning null is a normal outcome, not an error: most features have no media at all.
 */
export function resolveMedia<F extends SourceFeature>(
  layer: MapLayerDefinition<F>,
  feature: F,
): LayerMedia | null {
  const media = layer.media?.(feature) ?? null;
  if (!media) return null;

  let parsed: URL;
  try {
    parsed = new URL(media.url);
  } catch {
    return null;
  }

  const allowed = media.kind === "link" ? ["http:", "https:"] : ["https:"];
  if (!allowed.includes(parsed.protocol)) return null;
  if (parsed.host !== media.host) return null;
  if (media.disclosure.trim().length === 0) return null;

  if (media.kind !== "link") {
    const served = mediaClassFromUrl(media.url);
    if (served !== null && served !== media.kind) return null;
  }

  return media;
}

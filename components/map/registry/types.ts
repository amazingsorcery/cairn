import type {
  PositionalPrecision,
  SourceFailure,
  SourceFeature,
  SourceKind,
  SourceQuery,
} from "@/lib/sources/types";

/**
 * THE LAYER REGISTRY CONTRACT.
 *
 * A layer is a **record**, not a branch. Everything that differs between earthquakes and
 * aircraft — the label, the colour, the deck.gl layer, the table columns, the detail rows,
 * the empty sentence — is a field on `MapLayerDefinition`. The map component iterates the
 * registry and knows the name of no layer in particular.
 *
 * The test of this file is mechanical: `grep -rn 'earthquake' components/map/*.tsx` returns
 * nothing. `components/map/registry/` is the only place a layer is named, and adding a
 * source is adding one file there plus one line in `index.ts`. There is a regression test
 * for exactly that in `components/map/registry/registry.test.ts`.
 *
 * ## Why the deck.gl layer is a factory that RECEIVES its constructors
 *
 * The table, the legend and the toggles all need the registry, and they must work with no
 * WebGL at all (product-brief §2a: the table is a required equivalent, not a fallback). If a
 * registry entry wrote `new ScatterplotLayer(...)` against a top-level import, importing the
 * registry would pull `@deck.gl/layers` into the bundle of every component that reads a
 * column label — which is the whole page, including the no-JavaScript rendering.
 *
 * So the factory takes a `DeckKit` of constructors as an argument, and only
 * `components/map/deck-map.tsx` — which is itself only ever reached through a dynamic
 * import, after the reader opts in — ever holds the real ones. Every deck.gl reference in
 * this file is `import type` or `typeof import(...)`, both of which TypeScript erases, so
 * this module has **no runtime dependency on deck.gl**.
 */

/**
 * What the reader is currently looking at, in geographic terms.
 *
 * Handed to a layer's `query` so a viewport-scoped source can ask for the right patch of the
 * world. It is the ONLY thing about the reader that reaches a source, and it is quantised
 * before it is used as a cache key so that many readers looking at roughly the same place
 * share one upstream call (ADR 0014 §4) rather than each generating their own.
 */
export interface MapViewport {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * `[r, g, b, a]`, 0–255, which is deck.gl's colour format.
 *
 * Deliberately mutable rather than `readonly`: deck.gl's own `Color` type is a mutable
 * tuple, and a `readonly` alias here would put an `as` cast in every layer factory. A cast
 * per layer to satisfy a modifier we chose is a worse trade than the modifier.
 */
export type Rgba = [number, number, number, number];

/**
 * A layer's colour, per theme, as literal RGBA.
 *
 * deck.gl draws into a WebGL canvas and cannot read a CSS custom property, so a layer colour
 * cannot be `var(--warning)`. It is therefore the one place in this product where a colour
 * is written as a literal, and `token` records which primitive in `app/tokens.css` it was
 * taken from so a palette change has a name to search for. The legend swatch reads the SAME
 * literal, so the dot beside the label and the dot on the map cannot drift apart.
 */
export interface LayerColour {
  readonly dark: Rgba;
  readonly light: Rgba;
  /** The `app/tokens.css` §1 primitive this was copied from, e.g. "--amber-300". */
  readonly token: string;
}

/**
 * The deck.gl constructors a layer factory may use.
 *
 * Adding a constructor here means adding it to the `import` in `deck-map.tsx`, which is a
 * deliberate friction: each one lands in the map chunk whether a layer uses it or not.
 */
export interface DeckKit {
  readonly ScatterplotLayer: typeof import("@deck.gl/layers").ScatterplotLayer;
  readonly IconLayer: typeof import("@deck.gl/layers").IconLayer;
  readonly PathLayer: typeof import("@deck.gl/layers").PathLayer;
}

/** What a factory is handed besides the constructors. */
export interface DeckLayerInput<F extends SourceFeature = SourceFeature> {
  /** Prefixed and unique across layers. Use it verbatim as the deck.gl layer `id`. */
  readonly id: string;
  readonly features: readonly F[];
  /** `SourceFeature.id` of the feature the reader has open, or null. */
  readonly selectedId: string | null;
  readonly colour: Rgba;
  /** The same colour lightened for the selected feature's halo. */
  readonly selectedColour: Rgba;
  /**
   * True when the reader has asked for reduced motion. A factory must not animate — no
   * `transitions`, no pulsing radius — when this is set.
   */
  readonly reducedMotion: boolean;
  onSelect: (featureId: string) => void;
}

/**
 * Returns one deck.gl layer, or several when a layer genuinely needs more than one pass
 * (a halo under a symbol, say). `unknown` is not used: the return is deck.gl's own `Layer`,
 * typed through an erased import.
 */
export type DeckLayerFactory<F extends SourceFeature = SourceFeature> = (
  kit: DeckKit,
  input: DeckLayerInput<F>,
) => import("@deck.gl/core").Layer | readonly import("@deck.gl/core").Layer[];

/**
 * One column of the accessible table.
 *
 * `value` is what the column sorts on; `format` is what the cell shows. They are separate
 * because magnitude sorts numerically and renders as "M 4.6", and a table that sorts on the
 * rendered string sorts "M 10.1" before "M 4.6".
 *
 * `format` returns `string | null`, never a React node. A null renders as an em dash with a
 * screen-reader "not reported" — an absence and a rendering failure must not look the same,
 * which is the rule `components/live/flights-table.tsx` established.
 */
export interface TableColumn<F extends SourceFeature = SourceFeature> {
  readonly key: string;
  /** Lower case, with its unit. "magnitude", "depth (km)". */
  readonly label: string;
  /** Right-aligned and tabular when true. */
  readonly numeric: boolean;
  readonly value: (feature: F) => string | number | null;
  readonly format?: (feature: F) => string | null;
  /**
   * Exactly one column per layer sets this. It becomes the row's `<th scope="row">` and the
   * button that opens the detail panel, so every row has a header cell naming it.
   */
  readonly rowHeader?: boolean;
  /** Sort direction applied the first time a reader activates this column. */
  readonly initialDirection?: SortDirection;
}

export type SortDirection = "asc" | "desc";

export interface TableSort {
  readonly key: string;
  readonly direction: SortDirection;
}

/** One line in the feature detail panel. */
export interface DetailRow<F extends SourceFeature = SourceFeature> {
  readonly label: string;
  readonly value: (feature: F) => string | null;
  /** Monospace for identifiers, coordinates and hashes. */
  readonly mono?: boolean;
}

/**
 * How well a feature's coordinates locate the thing they describe.
 *
 * ## Why this is on the contract and not in one layer's copy
 *
 * The NWS alerts adapter measured 385 active alerts and found **five** carrying their own
 * warning polygon — 1.3%. The other 98.7% name only administrative UGC zone codes, which the
 * adapter resolves to that zone's centroid. That point can be tens of kilometres from where
 * the weather actually is, and the alert may cover several zones besides.
 *
 * Drawing those as ordinary dots would be the map confidently lying, and on a public-safety
 * layer that is the worst thing it could do — a reader deciding whether a warning covers a
 * place would be reading our arithmetic as the National Weather Service's finding.
 *
 * It is a registry field rather than a weather special case because it is not a weather
 * problem. A zone centroid, an ADS-B position 30 seconds old, a camera geocoded to a road
 * name and a fire detection with a 375 m pixel footprint are all the same statement: *this
 * coordinate is an approximation, and here is what of*. Any layer that can say it, should.
 *
 * `null` means the coordinate is the thing's own reported position, which needs no caveat.
 */
export type FeaturePrecision = PositionalPrecision;

/** The legend entry. Shape is carried as well as colour: colour is never the only signal. */
export interface LegendEntry {
  readonly label: string;
  /** "circle" is a filled dot; "graduated" adds the size-means-magnitude sentence. */
  readonly symbol: "circle" | "graduated";
  /** One sentence saying what the symbol encodes, or null when it encodes only presence. */
  readonly note: string | null;
}

/**
 * A layer, in full. Every field is data; none of it is a branch in a component.
 */
export interface MapLayerDefinition<F extends SourceFeature = SourceFeature> {
  /** Stable, url-safe, and equal to the adapter slug it draws from. */
  readonly id: string;
  /** `SourceAdapter.slug`. The server resolves this to an adapter; the client never does. */
  readonly sourceSlug: string;
  /**
   * What to ask the source for, given what the reader is looking at.
   *
   * Most layers ignore the viewport entirely — USGS publishes one global feed and slicing it
   * server-side would only mean re-fetching it every time somebody pans. Viewport-scoped
   * sources (aircraft) return one here, and that is the point: **the registry holds a
   * source, not a source bound to a viewport.** Baking the viewport in at construction works
   * right up until two viewports are needed, and then the registry is quietly holding two
   * copies of the same thing under different slugs.
   *
   * Omitted means "the whole feed", which is `{}`.
   */
  readonly query?: (viewport: MapViewport) => SourceQuery;
  readonly kind: SourceKind;
  /** Sentence case, plural. "Earthquakes". */
  readonly label: string;
  /** One sentence for the toggle's description and the table caption. */
  readonly description: string;
  /** Whether the layer is on when the map first opens. Keep this to one or two layers. */
  readonly defaultVisible: boolean;
  readonly colour: LayerColour;
  readonly legend: LegendEntry;
  readonly deck: DeckLayerFactory<F>;
  readonly columns: readonly TableColumn<F>[];
  readonly detail: readonly DetailRow<F>[];
  /**
   * How well this feature's coordinates locate it — **the fallback, not the primary source.**
   *
   * `PositionalPrecision` now lives on `SourceFeature` itself, which is the right home: the
   * adapter has the upstream in front of it, and putting it there means the caveat survives
   * into a workspace snapshot and a PDF export rather than existing only inside a map
   * component. `featurePrecision()` prefers the feature's own value and falls back to this.
   *
   * Keep this only while a layer's adapter has not adopted the field; delete it once it has.
   */
  readonly precision?: (feature: F) => FeaturePrecision | null;
  /** Default table order. Must name a column in `columns`. */
  readonly defaultSort: TableSort;
  /** Shown when the source answered and returned nothing. Never "no results". */
  readonly emptyMessage: string;
  /** Headline for this layer's unavailable state. "Earthquakes unavailable". */
  readonly unavailableTitle: string;
  /**
   * True for a layer that exists only in development — a stress harness, a fixture probe.
   * `MAP_LAYERS` filters these out of a production build, so one cannot reach a reader.
   */
  readonly devOnly?: boolean;
}

/**
 * The attribution and identity of the source behind a layer, as it crosses to the client.
 *
 * It is derived from `SourceAdapter.attribution` on the server rather than restated here,
 * which is what makes it impossible for the UI to forget: a layer cannot render its status
 * row without having been handed the credit its licence requires.
 */
export interface LayerSourceDto {
  readonly slug: string;
  readonly name: string;
  readonly homepage: string;
  readonly attribution: {
    readonly text: string;
    readonly href?: string;
    readonly licence: string;
  };
  /** Seconds. Drives the client's poll cadence — never a number chosen in the UI. */
  readonly ttlSeconds: number;
}

/**
 * One layer's data as it crosses the server/client boundary.
 *
 * `Date` does not survive JSON, and ADR 0014 §1 requires the age to be recomputed from the
 * observation instant on every tick rather than baked in at response time — so the instants
 * are ISO strings and the age is derived in the client, every second, from them.
 *
 * A failure is carried IN the payload rather than thrown. One dead upstream disables its own
 * layer and nothing else (product-brief §2b), and an exception crossing this boundary is how
 * one source takes down a map.
 */
export type LayerPayloadDto =
  | {
      readonly layerId: string;
      readonly source: LayerSourceDto;
      readonly ok: true;
      readonly features: readonly SourceFeature[];
      /** ISO instant the upstream observed this, not when we cached it. */
      readonly observedAt: string;
      /**
       * Served past its TTL because the upstream could not be reached.
       *
       * It comes from `CachedSourceResult`, never from `SourceResult`. An adapter has just
       * called upstream, so `false` is the only value it could honestly set; only the layer
       * holding the cache entry knows it is serving something expired. `cachedAt` is on that
       * wrapper too and is deliberately NOT carried here: the reader gets exactly one age on
       * this surface and it is computed from `observedAt` (ADR 0014 §1). A second timestamp
       * a few seconds different is the two-clocks problem in miniature.
       */
      readonly stale: boolean;
    }
  | {
      readonly layerId: string;
      readonly source: LayerSourceDto | null;
      readonly ok: false;
      readonly failure: SourceFailure;
      /** ISO instant of the last payload we did get, if there was one. */
      readonly lastGoodAt: string | null;
    };

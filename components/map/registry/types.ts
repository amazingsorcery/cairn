import type {
  PositionalPrecision,
  SourceFailure,
  SourceFeature,
  SourceKind,
  SourceQuery,
} from "@/lib/sources/types";

/**
 * Layer registry contract. Everything that differs between layers is a field on
 * `MapLayerDefinition`; components iterate the registry and never name a layer.
 * `registry.test.ts` enforces this. Adding a source is one file here plus a line in `index.ts`.
 *
 * deck.gl layers are factories that receive their constructors (`DeckKit`), so the registry
 * has no runtime deck.gl dependency: the table, legend and toggles use it without WebGL, and
 * only the dynamically imported `deck-map.tsx` holds the real constructors.
 */

/**
 * The visible area, passed to a layer's `query`. The only reader data that reaches a source;
 * quantised before keying the cache so nearby readers share one upstream call.
 */
export interface MapViewport {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * `[r, g, b, a]`, 0–255 (deck.gl's colour format). Mutable to match deck.gl's `Color` and
 * avoid casts in every factory.
 */
export type Rgba = [number, number, number, number];

/**
 * A layer's colour per theme, as literal RGBA since WebGL can't read CSS variables. `token`
 * names the `app/tokens.css` primitive it was copied from. The legend uses the same value.
 */
export interface LayerColour {
  readonly dark: Rgba;
  readonly light: Rgba;
  /** The `app/tokens.css` primitive this was copied from, e.g. "--amber-300". */
  readonly token: string;
}

/**
 * The deck.gl constructors a layer factory may use. Each one must also be imported in
 * `deck-map.tsx` and ships in the map chunk.
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
  /** Reduced motion requested: no `transitions` or animated radius. */
  readonly reducedMotion: boolean;
  onSelect: (featureId: string) => void;
}

/** Returns one deck.gl layer, or several for multi-pass rendering (e.g. a halo). */
export type DeckLayerFactory<F extends SourceFeature = SourceFeature> = (
  kit: DeckKit,
  input: DeckLayerInput<F>,
) => import("@deck.gl/core").Layer | readonly import("@deck.gl/core").Layer[];

/**
 * One table column. `value` is sorted on, `format` is displayed (so "M 10.1" sorts after
 * "M 4.6"). `null` renders as an em dash with "not reported" for screen readers.
 */
export interface TableColumn<F extends SourceFeature = SourceFeature> {
  readonly key: string;
  /** Lower case, with its unit. "magnitude", "depth (km)". */
  readonly label: string;
  /** Right-aligned and tabular when true. */
  readonly numeric: boolean;
  readonly value: (feature: F) => string | number | null;
  readonly format?: (feature: F) => string | null;
  /** Set on exactly one column: the row's `<th scope="row">` and the detail-panel button. */
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
 * How well a feature's coordinates locate the thing they describe; `null` when the
 * coordinate is the reported position.
 *
 * E.g. only ~1.3% of NWS alerts carry their own polygon; the rest are resolved to UGC zone
 * centroids, which can be tens of km off. Also applies to stale ADS-B positions, geocoded
 * cameras and 375 m fire-detection pixels.
 */
export type FeaturePrecision = PositionalPrecision;

/**
 * A feature's media (camera image, clip, radio audio, stream).
 *
 * - The browser connects to the operator directly; our server never relays the bytes
 *   (redistribution, and bandwidth: ~2.1 TB/month for fifty radio listeners).
 * - Nothing connects until the reader presses the control.
 * - `host` must match `url`; `resolveMedia` drops the record otherwise.
 * - `credit` is a licence requirement (TfL wording incl. the Ordnance Survey notice;
 *   Fintraffic CC BY). `null` only when none is required (Radio Browser is public domain).
 */
interface LayerMediaBase {
  /**
   * Absolute URL the client loads. `https:` for embedded media (anything else is mixed
   * content); `http:` only for `link`, which is a top-level navigation.
   */
  readonly url: string;
  /** Host from that URL. Named in the disclosure and in the control's own label. */
  readonly host: string;
  /** Plain-language statement of what the control connects to and who sees what. */
  readonly disclosure: string;
  /** The credit the licence requires beside the media, or null when none is required. */
  readonly credit: string | null;
}

/**
 * Discriminated union so `video` must set `refreshNote` (even to null) and `stream` must
 * set `medium` (an `.m3u8` doesn't say whether it's audio or video).
 */
export type LayerMedia =
  /** A still frame, loaded on press. */
  | (LayerMediaBase & { readonly kind: "image" })
  /** Progressive audio (Icecast, SHOUTcast, MP3). Not HLS; see `stream`. */
  | (LayerMediaBase & { readonly kind: "audio" })
  /**
   * A video file the operator replaces periodically (e.g. TfL JamCam MP4s). Not live: it
   * doesn't advance while playing, and the UI says so.
   */
  | (LayerMediaBase & {
      readonly kind: "video";
      /** The operator's own statement of how often the file is replaced, or `null`. Never estimated. */
      readonly refreshNote: string | null;
    })
  /**
   * Live HLS. Native on Safari/iOS; elsewhere hls.js is loaded on open (`media/hls.ts`) and
   * needs `connect-src` for the host. Where that can't be allowed, use `link` instead.
   */
  | (LayerMediaBase & {
      readonly kind: "stream";
      /** Which element to render. */
      readonly medium: "audio" | "video";
    })
  /**
   * A labelled link out, for media we can't embed: not permitted, blocked (e.g. the ~20% of
   * Radio Browser stations on plain `http:`, which fail silently as mixed content), or a host
   * we can't allow-list.
   */
  | (LayerMediaBase & { readonly kind: "link" });

/** The legend entry. Shape is carried as well as colour: colour is never the only signal. */
export interface LegendEntry {
  readonly label: string;
  /** "circle" is a filled dot; "graduated" adds the size-means-magnitude sentence. */
  readonly symbol: "circle" | "graduated";
  /** One sentence saying what the symbol encodes, or null when it encodes only presence. */
  readonly note: string | null;
}

/** A layer definition. */
export interface MapLayerDefinition<F extends SourceFeature = SourceFeature> {
  /** Stable, url-safe, and equal to the adapter slug it draws from. */
  readonly id: string;
  /** `SourceAdapter.slug`. The server resolves this to an adapter; the client never does. */
  readonly sourceSlug: string;
  /**
   * What to ask the source for at a viewport. Only viewport-scoped sources (aircraft) need
   * it; omitted means the whole feed (`{}`).
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
   * Fallback precision for adapters that don't yet set `SourceFeature.precision`.
   * `featurePrecision()` prefers the feature's own value. Remove once the adapter sets it.
   */
  readonly precision?: (feature: F) => FeaturePrecision | null;
  /**
   * The feature's media, or null. Read via `resolveMedia()`, which checks the protocol and
   * that `host` matches `url`.
   */
  readonly media?: (feature: F) => LayerMedia | null;
  /**
   * Feed (`"live"`, default) or hand-checked registry. A registry shows the date it was last
   * checked instead of "Live" and a ticking age.
   */
  readonly cadence?: "live" | "registry";
  /** Default table order. Must name a column in `columns`. */
  readonly defaultSort: TableSort;
  /** Shown when the source answered and returned nothing. Never "no results". */
  readonly emptyMessage: string;
  /** Headline for this layer's unavailable state. "Earthquakes unavailable". */
  readonly unavailableTitle: string;
  /** Development-only layer (stress harness etc.); filtered out of production `MAP_LAYERS`. */
  readonly devOnly?: boolean;
}

/** The source behind a layer, including its required attribution (from `SourceAdapter`). */
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
 * One layer's data as sent to the client. Instants are ISO strings; the client derives the
 * age from them each tick. Failures are values, not exceptions, so one dead source only
 * affects its own layer.
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
       * Served past its TTL because the upstream was unreachable. From `CachedSourceResult`
       * (only the cache knows it's expired). `cachedAt` isn't sent: the only age shown is
       * from `observedAt`.
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

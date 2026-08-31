import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, Rgba } from "./types";
import { instantProp, instantValue, stringProp } from "./props";

/**
 * Active US weather alerts, from the National Weather Service.
 *
 * ## The reason this layer exists in the shape it does
 *
 * Of 385 active alerts measured on 2026-08-31, **five** carried their own warning polygon.
 * The other 98.7% name only administrative UGC zone codes, which the adapter resolves to that
 * zone's centroid — a point that can be tens of kilometres from where the weather actually
 * is, on an alert that may cover several zones besides the one we placed it on.
 *
 * A dot is a claim about a location. Drawing 380 administrative centroids as ordinary dots
 * would be this map asserting, in the National Weather Service's name, that a tornado warning
 * is at a coordinate the National Weather Service never gave. On a public-safety layer that
 * is the worst available failure, and it fails silently and looks fine.
 *
 * So every feature carries `locationBasis`, and this layer says so in three places at once:
 *   - **on the map**, where a zone-derived alert is drawn hollow and larger, so it reads as a
 *     region rather than a point, and a polygon-derived one is drawn solid;
 *   - **in the table**, in the position cell, next to the coordinates it qualifies;
 *   - **in the detail panel**, as a sentence saying what the reader must not conclude.
 *
 * The mechanism is `MapLayerDefinition.precision`, which is on the contract rather than in
 * this file, because "this coordinate is an approximation and here is what of" is not a
 * weather problem — see `registry/types.ts`.
 *
 * ## The property names this file reads
 *
 * From `lib/sources/nws-alerts.ts`, and listed in `docs/frontend/HANDOFF-map.md` §3:
 *
 *   event                 string   "Severe Thunderstorm Warning" — the classification
 *   severity              string   Extreme | Severe | Moderate | Minor | Unknown (CAP)
 *   urgency               string   Immediate | Expected | Future | Past | Unknown
 *   certainty             string   Observed | Likely | Possible | Unlikely | Unknown
 *   headline              string   the upstream's own one-line summary
 *   areaDescription       string   plain-language area, often better than the point
 *   effectiveAt           string   ISO 8601
 *   expiresAt             string   ISO 8601
 *   issuedBy              string   the office that issued it
 *   recommendedResponse   string   Shelter | Evacuate | Avoid | Monitor | None
 *   locationBasis         string   "polygon" | "zone" — how the point was derived
 *   zoneCode              string   the UGC zone, when the basis is zone
 *   coversMultipleZones   boolean  the alert names more zones than the one we placed it on
 */

/** --azure-300 #74C6F2 and --azure-700 #11527A. */
const AZURE_300: Rgba = [116, 198, 242, 215];
const AZURE_700: Rgba = [17, 82, 122, 230];

/**
 * CAP severity, ordered so the table can sort on it.
 *
 * A string sort would put "Extreme" next to "Expected" and "Minor" above "Moderate", which
 * on a safety layer is not a cosmetic defect: "sort by severity" is the one thing a reader
 * does with this table, and alphabetical order answers a different question.
 */
const SEVERITY_ORDER: Record<string, number> = {
  Extreme: 5,
  Severe: 4,
  Moderate: 3,
  Minor: 2,
  Unknown: 1,
};

function severityRank(feature: SourceFeature): number | null {
  const severity = stringProp(feature, "severity");
  return severity === null ? null : (SEVERITY_ORDER[severity] ?? 1);
}

function isZoneDerived(feature: SourceFeature): boolean {
  return stringProp(feature, "locationBasis") === "zone";
}

/** `31/08/2026 11:25 UTC`. Absolute and in UTC, for the reason given in `earthquakes.ts`. */
function formatInstant(feature: SourceFeature, key: string): string | null {
  const date = instantProp(feature, key);
  if (!date) return null;
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })
    .format(date)
    .replace(",", "")} UTC`;
}

export const weatherAlertsLayer: MapLayerDefinition = {
  id: "weather-alerts",
  sourceSlug: "nws-alerts",
  kind: "weather",
  label: "Weather alerts",
  description:
    "Active warnings, watches and advisories from the US National Weather Service. United States only.",
  /*
   * OFF by default, and not because it is unimportant. Almost every one of these is placed on
   * an administrative centroid, and a reader who opens the map and sees dots has to be given
   * the chance to read what the dots mean before they appear.
   */
  defaultVisible: false,

  colour: { dark: AZURE_300, light: AZURE_700, token: "--azure-300 / --azure-700" },

  legend: {
    label: "Weather alerts",
    symbol: "circle",
    note: "A hollow ring means the point is an administrative zone centre, not the weather — the alert covers the whole zone, not that spot.",
  },

  /**
   * THE PRECISION CAVEAT, ON THE CONTRACT'S OWN FIELD.
   *
   * Returning null for a polygon-derived alert matters as much as returning a note for a
   * zone-derived one: caveating everything is the same as caveating nothing, and the 1.3% of
   * alerts that DO carry their own geometry deserve to be read as the precise thing they are.
   */
  precision: (feature): FeaturePrecision | null => {
    if (!isZoneDerived(feature)) return null;
    const zone = stringProp(feature, "zoneCode");
    const multiple = feature.properties.coversMultipleZones === true;
    return {
      label: "zone centre",
      note:
        `This alert carries no map geometry, so it is drawn at the centre of ` +
        `${zone === null ? "the administrative zone it names" : `zone ${zone}`}. ` +
        `The weather may be tens of kilometres from this point, and the alert applies to the ` +
        `whole zone rather than to this spot.` +
        (multiple ? " It also names further zones that are not drawn here." : ""),
    };
  },

  deck: (kit, input) =>
    new kit.ScatterplotLayer<SourceFeature>({
      id: input.id,
      data: input.features,
      pickable: true,
      stroked: true,
      /*
       * FILLED ONLY WHEN THE POINT IS REAL. A zone-derived alert is drawn as a hollow ring,
       * which reads as "somewhere around here" rather than "here" — the visual grammar every
       * map already uses for an area versus a point. It is not the only signal: the table
       * says "zone centre" beside the coordinates and the detail panel says it in a sentence.
       */
      getFillColor: (f) =>
        isZoneDerived(f) ? [0, 0, 0, 0] : input.colour,
      filled: true,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      /* Zone rings are larger, because they stand for an area rather than a location. */
      getRadius: (f) => (isZoneDerived(f) ? 11 : 7),
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 2),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /* Nothing moves on this layer. An alert appears, persists and expires. */
      transitions: {},
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      key: "event",
      label: "alert",
      numeric: false,
      rowHeader: true,
      initialDirection: "asc",
      value: (f) => stringProp(f, "event"),
    },
    {
      key: "severity",
      label: "severity",
      numeric: false,
      initialDirection: "desc",
      /* Sorts on the CAP rank, renders the word. See `SEVERITY_ORDER`. */
      value: severityRank,
      format: (f) => stringProp(f, "severity"),
    },
    {
      key: "areaDescription",
      label: "area",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "areaDescription"),
    },
    {
      key: "expiresAt",
      label: "expires (UTC)",
      numeric: true,
      initialDirection: "asc",
      value: (f) => instantValue(f, "expiresAt"),
      format: (f) => formatInstant(f, "expiresAt"),
    },
    {
      key: "recommendedResponse",
      label: "advised action",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "recommendedResponse"),
    },
  ],

  detail: [
    { label: "Alert", value: (f) => stringProp(f, "event") },
    { label: "Headline", value: (f) => stringProp(f, "headline") },
    { label: "Severity", value: (f) => stringProp(f, "severity") },
    { label: "Urgency", value: (f) => stringProp(f, "urgency") },
    { label: "Certainty", value: (f) => stringProp(f, "certainty") },
    { label: "Area", value: (f) => stringProp(f, "areaDescription") },
    { label: "Advised action", value: (f) => stringProp(f, "recommendedResponse") },
    { label: "In effect from", value: (f) => formatInstant(f, "effectiveAt") },
    { label: "Expires", value: (f) => formatInstant(f, "expiresAt") },
    { label: "Issued by", value: (f) => stringProp(f, "issuedBy") },
  ],

  defaultSort: { key: "severity", direction: "desc" },

  emptyMessage:
    "The National Weather Service reports no active alerts. That is a real answer about the United States, and it says nothing about weather anywhere else.",
  unavailableTitle: "Weather alerts unavailable",
};

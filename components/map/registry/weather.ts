import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, Rgba } from "./types";
import { instantProp, instantValue, stringProp } from "./props";

/**
 * Active US weather alerts from the National Weather Service.
 *
 * Only 5 of 385 alerts (measured 2026-08-31) carried their own polygon; the rest name UGC
 * zones, which the adapter resolves to zone centroids that can be tens of km from the
 * weather. `locationBasis` marks which, and zone-derived alerts are flagged on the map
 * (hollow, larger), in the table and in the detail panel via `precision`.
 *
 * Properties read (from `lib/sources/nws-alerts.ts`):
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

/** CAP severity rank, so the table sorts by severity rather than alphabetically. */
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
  /* Off by default: most points are zone centroids, so readers should opt in knowingly. */
  defaultVisible: false,

  colour: { dark: AZURE_300, light: AZURE_700, token: "--azure-300 / --azure-700" },

  legend: {
    label: "Weather alerts",
    symbol: "circle",
    note: "A hollow ring means the point is an administrative zone centre, not the weather — the alert covers the whole zone, not that spot.",
  },

  /** Caveat for zone-derived alerts only; polygon-derived ones return null. */
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
      /* Zone-derived alerts are hollow rings (an area, not a point). */
      getFillColor: (f) =>
        isZoneDerived(f) ? [0, 0, 0, 0] : input.colour,
      filled: true,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      /* Zone rings are larger since they stand for an area. */
      getRadius: (f) => (isZoneDerived(f) ? 11 : 7),
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 2),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /* Nothing to animate. */
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

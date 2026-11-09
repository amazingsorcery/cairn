import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, MapViewport, Rgba } from "./types";
import { boolProp, numberProp, stringProp } from "./props";

/**
 * Aircraft broadcasting ADS-B positions, via the adsb.lol community receiver network. The
 * only viewport-scoped layer (uses `query`).
 *
 * adsb.lol publishes no rate limit, sends no `Retry-After`, and was measured refusing around
 * 10 requests/minute. The connector has a 60 s TTL and a global ceiling of 6 calls/minute
 * (about three viewports). Don't add a refresh control, a shorter cadence, or a `limit`.
 *
 * Properties read (from `lib/sources/adsb-lol.ts`):
 *
 *   icao24              string   ICAO 24-bit address, lower case. The stable identity
 *   callsign            string   broadcast by the aircraft. NOT resolved to an operator here
 *   registration        string   tail number, where the network knows it
 *   aircraftType        string   ICAO type code, e.g. B738
 *   altitudeFt          number   barometric altitude. NULL on the ground and when unreported
 *   onGround            boolean  the upstream sent the literal "ground" for altitude
 *   groundSpeedKt       number   knots
 *   trackDeg            number   degrees true
 *   verticalRateFpm     number   feet per minute, negative for a descent
 *   squawk              string   transponder code
 *   emergency           string   the upstream's own reading, null when there is none
 *   positionAgeSeconds  number   seconds since the network last heard this aircraft's position
 *
 * Normal absences:
 * 1. `alt_baro` is `"ground"` on about a quarter of aircraft; the adapter maps it to
 *    `altitudeFt: null` + `onGround: true`. Shown as "on ground" and sorted at zero.
 * 2. Missing callsigns: `label` falls back to registration, then the ICAO address.
 */

/** --mint-200 #A3F0D8 and --mint-700 #084B3E, per `app/tokens.css`. */
const MINT_200: Rgba = [163, 240, 216, 225];
const MINT_700: Rgba = [8, 75, 62, 235];

/**
 * A viewport this wide means no area has been chosen. The endpoint answers a ≤250 nm circle,
 * so the world view would query an empty circle at 0°N 0°E. Instead, send no bbox and let
 * the adapter use its fallback area (`AIRCRAFT_VIEWPORT`, greater London by default).
 */
const NO_AREA_CHOSEN_DEGREES = 180;

const NUMBER = new Intl.NumberFormat("en-GB");

/** Metres travelled in `seconds` at `knots`. One nautical mile is 1852 m. */
function metresTravelled(knots: number, seconds: number): number {
  return (knots * 1852 * seconds) / 3600;
}

function isOnGround(feature: SourceFeature): boolean {
  return boolProp(feature, "onGround") === true;
}

/** Altitude sort key: 0 for aircraft on the ground, null only when genuinely unreported. */
function altitudeValue(feature: SourceFeature): number | null {
  const altitude = numberProp(feature, "altitudeFt");
  if (altitude !== null) return altitude;
  return isOnGround(feature) ? 0 : null;
}

function formatAltitude(feature: SourceFeature): string | null {
  const altitude = numberProp(feature, "altitudeFt");
  if (altitude !== null) return `${NUMBER.format(Math.round(altitude))} ft`;
  return isOnGround(feature) ? "on ground" : null;
}

function formatSpeed(feature: SourceFeature): string | null {
  const speed = numberProp(feature, "groundSpeedKt");
  return speed === null ? null : `${NUMBER.format(Math.round(speed))} kt`;
}

/** `273°`. True track, as broadcast. */
function formatTrack(feature: SourceFeature): string | null {
  const track = numberProp(feature, "trackDeg");
  return track === null ? null : `${Math.round(track)}°`;
}

/**
 * "climbing 1,200 ft/min" rather than a signed number. Under 64 ft/min (the broadcast
 * resolution) is "level".
 */
function formatVerticalRate(feature: SourceFeature): string | null {
  const rate = numberProp(feature, "verticalRateFpm");
  if (rate === null) return null;
  if (Math.abs(rate) < 64) return "level";
  const magnitude = NUMBER.format(Math.abs(Math.round(rate)));
  return rate > 0 ? `climbing ${magnitude} ft/min` : `descending ${magnitude} ft/min`;
}

function formatPositionAge(feature: SourceFeature): string | null {
  const age = numberProp(feature, "positionAgeSeconds");
  if (age === null) return null;
  const seconds = Math.round(age);
  return `${NUMBER.format(seconds)} s since the network last heard from it`;
}

/**
 * Position age past which the dot gets a caveat. A cruising jet covers ~4 km in 30 s. This
 * is per-aircraft (time since the network last heard it), separate from the layer's age.
 */
const STALE_POSITION_SECONDS = 30;

function aircraftPrecision(feature: SourceFeature): FeaturePrecision | null {
  const age = numberProp(feature, "positionAgeSeconds");
  if (age === null || age < STALE_POSITION_SECONDS) return null;
  const seconds = Math.round(age);
  const speed = numberProp(feature, "groundSpeedKt");

  if (speed === null || speed <= 0) {
    return {
      label: `position ${NUMBER.format(seconds)} s old`,
      note:
        `The receiver network last heard a position from this aircraft ${NUMBER.format(seconds)} ` +
        `seconds ago, and it reported no ground speed, so there is no way to say how far it ` +
        `has moved since. The dot is where it was, not where it is.`,
    };
  }

  const metres = metresTravelled(speed, seconds);
  return {
    label: `position ${NUMBER.format(seconds)} s old`,
    note:
      `The receiver network last heard a position from this aircraft ${NUMBER.format(seconds)} ` +
      `seconds ago. At its last reported ground speed of ${NUMBER.format(Math.round(speed))} ` +
      `knots it would have travelled roughly ${NUMBER.format(Math.round(metres / 1000))} km ` +
      `since, in whatever direction it has been flying. The dot is where it was.`,
    approximateRadiusMetres: Math.round(metres),
  };
}

export const aircraftLayer: MapLayerDefinition = {
  id: "aircraft",
  sourceSlug: "adsb-lol",
  kind: "aircraft",
  label: "Aircraft",
  description:
    "Aircraft broadcasting ADS-B positions, as received by the volunteer adsb.lol network. The source answers for one circle of up to 250 nautical miles rather than for the world, so zoom to the area you are asking about.",
  /* Off by default so readers who don't want aircraft don't poll the rate-limited source. */
  defaultVisible: false,

  colour: { dark: MINT_200, light: MINT_700, token: "--mint-200 / --mint-700" },

  legend: {
    label: "Aircraft",
    symbol: "circle",
    note: "A hollow dot is an aircraft on the ground rather than in the air.",
  },

  /**
   * Viewport as a bbox; the adapter converts it to centre + radius, clamped to 250 nm, so a
   * wide view is answered for its middle.
   */
  query: (viewport: MapViewport) =>
    Math.abs(viewport.east - viewport.west) >= NO_AREA_CHOSEN_DEGREES ? {} : { bbox: viewport },

  precision: aircraftPrecision,

  deck: (kit, input) =>
    new kit.ScatterplotLayer<SourceFeature>({
      id: input.id,
      data: input.features,
      pickable: true,
      stroked: true,
      filled: true,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      /* 4 px minimum for tap targets. */
      getRadius: (f) => (isOnGround(f) ? 4 : 5.5),
      /* Hollow = on the ground (also stated in the table and detail panel). */
      getFillColor: (f) => (isOnGround(f) ? [0, 0, 0, 0] : input.colour),
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1.5),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /*
       * No position transitions: interpolating would draw a path the source never reported.
       * The 10,000-point performance budget was also measured with transitions off.
       */
      transitions: {},
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      key: "aircraft",
      label: "aircraft",
      numeric: false,
      rowHeader: true,
      initialDirection: "asc",
      /* Callsign, else registration, else ICAO address; never empty. */
      value: (f) => f.label,
    },
    {
      key: "aircraftType",
      label: "type",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "aircraftType"),
    },
    {
      key: "altitudeFt",
      label: "altitude (ft)",
      numeric: true,
      initialDirection: "desc",
      value: altitudeValue,
      format: formatAltitude,
    },
    {
      key: "groundSpeedKt",
      label: "speed (kt)",
      numeric: true,
      initialDirection: "desc",
      value: (f) => numberProp(f, "groundSpeedKt"),
      format: (f) => {
        const speed = numberProp(f, "groundSpeedKt");
        return speed === null ? null : NUMBER.format(Math.round(speed));
      },
    },
    {
      key: "trackDeg",
      label: "heading",
      numeric: true,
      initialDirection: "asc",
      value: (f) => numberProp(f, "trackDeg"),
      format: formatTrack,
    },
  ],

  detail: [
    {
      /* Not "flight": a broadcast callsign isn't a resolved operator or flight number. */
      label: "Callsign (as broadcast)",
      value: (f) => stringProp(f, "callsign"),
      mono: true,
    },
    { label: "Registration", value: (f) => stringProp(f, "registration"), mono: true },
    {
      label: "ICAO 24-bit address",
      value: (f) => stringProp(f, "icao24")?.toUpperCase() ?? null,
      mono: true,
    },
    { label: "Type code", value: (f) => stringProp(f, "aircraftType"), mono: true },
    { label: "Altitude", value: formatAltitude },
    { label: "Ground speed", value: formatSpeed },
    { label: "Heading", value: formatTrack },
    { label: "Vertical rate", value: formatVerticalRate },
    { label: "Squawk", value: (f) => stringProp(f, "squawk"), mono: true },
    {
      /* The adapter maps "none" to null, so the row only appears for a real emergency. */
      label: "Emergency (reported by the source)",
      value: (f) => stringProp(f, "emergency"),
    },
    { label: "Position last heard", value: formatPositionAge },
  ],

  defaultSort: { key: "aircraft", direction: "asc" },

  emptyMessage:
    "adsb.lol answered and reported no aircraft in the area it was asked about. Coverage comes from volunteers running receivers, so an empty result describes that network's reception here rather than the sky.",
  unavailableTitle: "Aircraft unavailable",
};

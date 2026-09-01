import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, MapViewport, Rgba } from "./types";
import { boolProp, numberProp, stringProp } from "./props";

/**
 * Aircraft broadcasting ADS-B positions, via the adsb.lol community receiver network.
 *
 * ## This is the layer the GPU layers exist for, and the one with the tightest leash
 *
 * It is also the only layer here whose source is scoped to a viewport, so it is the first
 * user of `MapLayerDefinition.query` — the field that exists so the registry can hold a
 * *source* rather than a source pre-bound to one patch of sky.
 *
 * **ADR 0021 is the constraint that shapes everything below.** adsb.lol publishes no rate
 * limit, sends no `Retry-After`, and was measured refusing requests from around ten a minute.
 * The connector row therefore carries a 60-second TTL and a global ceiling of six calls a
 * minute, which is roughly three concurrent viewports. Nothing in this file may widen that:
 * there is no per-layer refresh control, no shorter cadence, and no `limit` that would make
 * the count disagree with what the source actually returned.
 *
 * ## The property names this file reads
 *
 * From `lib/sources/adsb-lol.ts`, and listed in `docs/frontend/HANDOFF-map.md` §3:
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
 * ## Two absences that are normal here and must not render as damage
 *
 * 1. **`alt_baro` arrives as the string `"ground"` on about a quarter of a real response.**
 *    The adapter turns that into `altitudeFt: null` plus `onGround: true`, so a null altitude
 *    means one of two quite different things. The altitude column says "on ground" for the
 *    first and an em dash for the second, and it sorts ground traffic at zero rather than
 *    dropping it to the bottom with the genuinely unreported.
 * 2. **Some aircraft broadcast no callsign at all.** `SourceFeature.label` already falls back
 *    callsign → registration → upper-case ICAO address, so the row header and the detail
 *    heading always name something. There is no code path here that can produce a blank,
 *    unclickable feature.
 */

/** --mint-200 #A3F0D8 and --mint-700 #084B3E, per `app/tokens.css` §1. */
const MINT_200: Rgba = [163, 240, 216, 225];
const MINT_700: Rgba = [8, 75, 62, 235];

/**
 * A viewport this wide means the reader has not chosen an area.
 *
 * The endpoint answers for a circle of at most 250 nautical miles, and the map's opening view
 * — which is also what the server renders for — is the whole world. Turning that into a
 * bounding box hands the source a circle in the middle of the Atlantic, which spends one of
 * six permitted calls a minute proving that nobody is flying over 0°N 0°E, and then caches
 * that emptiness for a minute as though it were an answer about the world.
 *
 * So a world-scale viewport asks for no viewport at all, which the adapter documents as "use
 * the configured fallback area" (`AIRCRAFT_VIEWPORT`, greater London by default). The reader
 * sees real aircraft drawn where they really are, and the layer's own description says the
 * coverage is one circle rather than the globe.
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

/**
 * The sort key for altitude, which has to keep two different absences apart.
 *
 * An aircraft on the ground is not "altitude unknown" — the source said where it is, and it
 * is at the surface. Returning null for it would push every taxiing aircraft to the bottom of
 * the table alongside the ones that reported nothing at all, which is the absence-versus-zero
 * confusion this codebase keeps meeting. Zero is the honest number for the ground; null is
 * kept for a genuinely unreported altitude, and `sort.ts` floats those last in both
 * directions.
 */
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
 * "climbing 1,200 ft/min" rather than "1200".
 *
 * The sign is the whole content of this field and a bare negative number is read wrongly at a
 * glance. A rate under 64 ft/min is level flight in practice — that is the resolution the
 * field is broadcast at — so it is reported as level rather than as a number that implies a
 * measurement finer than the message carries.
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
 * When an aircraft's own position is old enough that the dot is a guess.
 *
 * **Deliberately not applied to every feature.** ADS-B positions are GPS-derived and most of
 * them are a few seconds old, which is as exact as this source gets — caveating those would
 * be caveating nothing. Thirty seconds is the threshold because a jet at cruise covers about
 * four kilometres in that time, which is further than an airport is wide and enough to change
 * which town it is over.
 *
 * The layer's *own* age is shown once in the status row (ADR 0014 §1). This is a different
 * number: how long since the receiver network last heard from this particular aircraft, which
 * can be much longer than our poll interval when it is out of a receiver's range.
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
  /*
   * OFF by default. Every layer in the registry is fetched when the page renders, visible or
   * not, so a default-on aircraft layer would poll a hard-limited community service on behalf
   * of every reader who opened the map to look at earthquakes. Six calls a minute is the
   * whole envelope (ADR 0021); this layer spends it only when someone asks for it.
   */
  defaultVisible: false,

  colour: { dark: MINT_200, light: MINT_700, token: "--mint-200 / --mint-700" },

  legend: {
    label: "Aircraft",
    symbol: "circle",
    note: "A hollow dot is an aircraft on the ground rather than in the air.",
  },

  /**
   * THE ONLY VIEWPORT-SCOPED LAYER, and the reason `query` is on the contract.
   *
   * The caller hands every layer the viewport and the registry decides what it means. Here it
   * becomes a bounding box, which the adapter converts to the centre-and-radius its endpoint
   * takes, clamped to the documented 250 nm maximum — so a wide view is answered for its
   * middle rather than refused.
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
      /* Screen-space, like every other layer here: an aircraft is a point, not an area. */
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      /*
       * Four pixels is the floor everywhere on this map, and it is a hit-target floor before
       * it is a visual one — below it the dot is hard to tap one-handed on a phone.
       */
      getRadius: (f) => (isOnGround(f) ? 4 : 5.5),
      /*
       * HOLLOW MEANS ON THE GROUND, and it is not the only signal: the altitude column says
       * "on ground" in words and the detail panel says it again. A parked aircraft and one at
       * 37,000 feet are the same dot otherwise, and at a busy airport the apron is most of
       * what is on screen.
       */
      getFillColor: (f) => (isOnGround(f) ? [0, 0, 0, 0] : input.colour),
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1.5),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /*
       * NO POSITION TRANSITION, and not only because of `prefers-reduced-motion`.
       *
       * Interpolating a dot from its old position to its new one draws a path this source
       * never reported: we observed two positions a minute apart and nothing in between. On a
       * layer whose own precision note is about how far an aircraft has moved unobserved,
       * animating that gap would be the map filling it in. It also keeps the 10,000-point
       * budget in `docs/frontend/HANDOFF-map.md` §5 measured rather than assumed — that
       * measurement was taken with transitions off.
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
      /*
       * The adapter's own fallback chain — callsign, then registration, then the ICAO
       * address — so the row header is never empty even for an aircraft that broadcasts no
       * identity at all.
       */
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
      /*
       * Named for what it is. A callsign is a string the aircraft broadcasts; it is not an
       * operator, not a flight number in an airline's system, and not an identity we have
       * resolved. Labelling it "flight" would invite exactly that inference.
       */
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
      /*
       * Present only when the upstream says so — it maps its own "none" to null — so this row
       * disappears rather than rendering the word "none", which would read as a state.
       */
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

import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, numberProp, stringProp } from "./props";

/**
 * Internet radio stations, from the Radio Browser community catalogue.
 *
 * ## Like the camera layer, this is a registry of points rather than a live feed
 *
 * Nothing here is happening. A station has a location because somebody typed one into a
 * community catalogue, and the value of the layer is the panel: who broadcasts, in what
 * language, on what codec, whether the catalogue's own checker could still reach the stream,
 * and where to hear it.
 *
 * ## The audio is never ours — product-brief §2b
 *
 * The stream URL is handed to the reader; the reader's browser is what connects to the
 * broadcaster. Relaying audio through one VPS exhausts its bandwidth in hours and turns a
 * linking site into a rebroadcasting one, which is a different legal posture entirely — and
 * the catalogue's public-domain dedication covers *the catalogue*, not the audio. The
 * maintainer dedicated the rights they had; a station's stream is not among them.
 *
 * **We also decline the catalogue's click telemetry.** Its API asks callers to report every
 * station a user opens so popular stations can be ranked. For a media player that is a fair
 * trade; here it would tell a third party which station each reader listened to, which is
 * precisely the interest-graph leak product-brief §3.2 constraint 4 forbids. The layer's
 * description says so, because a reader of this product should not have to take it on trust.
 *
 * **The panel cannot play the stream, and that is a contract gap rather than a decision.**
 * `DetailRow.value` returns a string, so a registry entry has no way to declare a player or
 * even a link, and adding one would mean editing `feature-detail.tsx` — the component change
 * the registry exists to prevent. Recorded in `docs/frontend/HANDOFF-map.md` §10 with the
 * field that would close it. Until then the panel gives the stream URL as text, states
 * whether it can play in a browser at all, and links to the station's own homepage through
 * `SourceFeature.sourceUrl`.
 *
 * ## One in five of these cannot play on this page, and we say which
 *
 * Measured by the integrations engineer on 2026-08-31: **20% of working geolocated stations
 * publish a plain `http:` stream URL** (2,473 of 12,413). A browser on an HTTPS page blocks
 * those as mixed content whatever our own policy says, and it does it silently — the reader
 * presses play, nothing happens, and concludes the tool is broken. They are surfaced rather
 * than filtered: dropping a fifth of the catalogue without saying so is the quiet
 * incompleteness this codebase has already been bitten by twice.
 *
 * ## The property names this file reads
 *
 * From `lib/sources/radio-browser.ts`, and listed in `docs/frontend/HANDOFF-map.md` §3:
 *
 *   stationUuid       string   the catalogue's own identifier
 *   streamUrl         string   what the CLIENT would connect to. Never fetched by us
 *   isHls             boolean  whether the stream is HLS
 *   isInsecureStream  boolean  plain http, so a browser on an https page will refuse it
 *   codec             string   MP3, AAC, …
 *   bitrateKbps       number   as the catalogue records it
 *   homepage          string   the station's own site
 *   country           string   country name, as recorded
 *   countryCode       string   ISO country code
 *   state             string   region, where recorded
 *   language          string   as recorded, comma separated
 *   tags              string   the catalogue's own free-text tags
 *   lastCheckOk       boolean  the catalogue's checker last found the stream playable
 *   lastCheckedAt     string   ISO 8601, when that check ran
 *   clickCount        number   how often catalogue users have opened it
 */

/**
 * --slate-300 #A8B9C9 and --slate-700 #2A3646, per `app/tokens.css` §1.
 *
 * The neutral, and it is a considered choice rather than what was left. Every other family in
 * the palette is spoken for by a layer, and the only unused one besides slate is red — which
 * on this product means destructive. A radio station is not an alert, and colouring it like
 * one would make the map read as though something were wrong in Helsinki. A seventh layer
 * will need a new primitive in `app/tokens.css`, which is the brand engineer's file.
 */
const SLATE_300: Rgba = [168, 185, 201, 220];
const SLATE_700: Rgba = [42, 54, 70, 235];

const NUMBER = new Intl.NumberFormat("en-GB");

/** `31/08/2026 09:14 UTC`. Absolute and in UTC, for the reason given in `earthquakes.ts`. */
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

/**
 * Whether the stream can play in a browser on this page, in the column and in three words.
 *
 * Not a padlock and not a colour: the consequence is functional rather than a security
 * grading, and "plain http" is the phrase that tells a reader why the audio will not start.
 */
function streamSecurity(feature: SourceFeature): string | null {
  const insecure = boolProp(feature, "isInsecureStream");
  if (insecure === null) return null;
  return insecure ? "plain http" : "https";
}

function formatBitrate(feature: SourceFeature): string | null {
  const bitrate = numberProp(feature, "bitrateKbps");
  /*
   * The catalogue records 0 for a station whose bitrate nobody has filled in, and rendering
   * "0 kbps" would read as a measurement rather than as a blank. It becomes an em dash and a
   * screen-reader "not reported", like every other absence on this map.
   */
  if (bitrate === null || bitrate <= 0) return null;
  return `${NUMBER.format(Math.round(bitrate))} kbps`;
}

/**
 * THE LOCATION CAVEAT, ON EVERY STATION.
 *
 * A dot on a map is read as "the thing is here", and for an internet radio station that
 * inference is wrong three times over: the coordinate is what somebody entered into a
 * community catalogue, it usually names a studio or a city rather than a transmitter, and an
 * internet stream has no coverage area at all — it plays anywhere with a connection.
 *
 * It is set for every feature because it is uniformly true of this source, which is a
 * different situation from the weather layer's 98.7%. There is no station here whose
 * coordinate is a precise, source-published position, so there is none to leave uncaveated.
 */
function stationPrecision(feature: SourceFeature): FeaturePrecision {
  const place = stringProp(feature, "country");
  return {
    label: "catalogue location",
    note:
      `This is the position recorded for the station in the Radio Browser catalogue, which ` +
      `contributors enter by hand — usually a studio or a city` +
      `${place === null ? "" : ` in ${place}`}, not a transmitter site. It says nothing about ` +
      `where a signal reaches: the stream is an internet stream and plays anywhere. Treat the ` +
      `dot as "the catalogue associates this station with here", not as a location you can cite.`,
  };
}

export const radioLayer: MapLayerDefinition = {
  id: "radio",
  sourceSlug: "radio-browser",
  kind: "radio",
  label: "Radio stations",
  description:
    "Internet radio stations the community catalogue records a position for — the 500 most-opened, which is under one percent of the catalogue. The position is where contributors say the station is, not where a signal reaches. We link to each stream and never relay it, and we do not tell the catalogue which stations you open.",
  defaultVisible: false,

  colour: { dark: SLATE_300, light: SLATE_700, token: "--slate-300 / --slate-700" },

  legend: {
    label: "Radio stations",
    symbol: "circle",
    note: "One dot per station, at the location its catalogue entry claims rather than at a transmitter. A hollow dot is a stream published over plain http, which a browser will not play on a secure page.",
  },

  precision: stationPrecision,

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
      /*
       * HOLLOW MEANS THE STREAM WILL NOT PLAY HERE. A plain-http stream is blocked as mixed
       * content by any browser on this page, so the difference between the two rings is
       * whether the thing the dot stands for is reachable at all — which is the most useful
       * distinction this layer can draw. The table says "plain http" in words in its own
       * column, so the ring is a shortcut rather than the only signal.
       */
      getFillColor: (f) => (boolProp(f, "isInsecureStream") === true ? [0, 0, 0, 0] : input.colour),
      getRadius: 5.5,
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1.5),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /* A station does not move, and the catalogue changes over days. Nothing to animate. */
      transitions: {},
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      key: "station",
      label: "station",
      numeric: false,
      rowHeader: true,
      initialDirection: "asc",
      /* The adapter falls back to "Unnamed station", so this is never blank. */
      value: (f) => f.label,
    },
    {
      key: "country",
      label: "country",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "country"),
    },
    {
      key: "language",
      label: "language",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "language"),
    },
    {
      key: "bitrateKbps",
      label: "bitrate (kbps)",
      numeric: true,
      initialDirection: "desc",
      value: (f) => {
        const bitrate = numberProp(f, "bitrateKbps");
        return bitrate === null || bitrate <= 0 ? null : bitrate;
      },
      format: formatBitrate,
    },
    {
      key: "stream",
      label: "stream",
      numeric: false,
      initialDirection: "asc",
      value: streamSecurity,
    },
  ],

  detail: [
    { label: "Country", value: (f) => stringProp(f, "country") },
    { label: "Region", value: (f) => stringProp(f, "state") },
    { label: "Language", value: (f) => stringProp(f, "language") },
    { label: "Tags", value: (f) => stringProp(f, "tags") },
    {
      label: "Audio",
      value: (f) => {
        const codec = stringProp(f, "codec");
        const bitrate = formatBitrate(f);
        const hls = boolProp(f, "isHls") === true ? "HLS" : null;
        const parts = [codec, bitrate, hls].filter((part): part is string => part !== null);
        return parts.length === 0 ? null : parts.join(" · ");
      },
    },
    /*
     * Text, not a link, for the same reason the camera layer shows its image URL as text: a
     * link would be a connection to a third party one stray tap away, and the reader should
     * make that choice knowing what it does. The row below says whether it can work at all.
     */
    { label: "Stream URL", value: (f) => stringProp(f, "streamUrl"), mono: true },
    {
      label: "Playing this stream",
      value: (f) => {
        const insecure = boolProp(f, "isInsecureStream");
        if (insecure === null) return null;
        return insecure
          ? "This station publishes its stream over plain http. A browser on a secure page blocks that as mixed content and fails silently, so it will not play here — opening the URL directly in a new tab still works. Either way your browser connects to the broadcaster, not to us."
          : "Your browser would connect to the broadcaster directly over https. Nothing about the audio passes through us, and we do not report to the catalogue that you opened it.";
      },
    },
    {
      label: "Catalogue's own check",
      value: (f) => {
        const ok = boolProp(f, "lastCheckOk");
        if (ok === null) return null;
        const when = formatInstant(f, "lastCheckedAt");
        const verdict = ok
          ? "the catalogue's checker last reached this stream successfully"
          : "the catalogue's checker could not reach this stream when it last tried";
        return when === null ? verdict : `${verdict}, ${when}`;
      },
    },
    {
      label: "Opened by catalogue users",
      value: (f) => {
        const clicks = numberProp(f, "clickCount");
        return clicks === null ? null : `${NUMBER.format(Math.round(clicks))} times`;
      },
    },
    { label: "Station identifier", value: (f) => stringProp(f, "stationUuid"), mono: true },
  ],

  defaultSort: { key: "station", direction: "asc" },

  emptyMessage:
    "The catalogue answered and listed no stations with coordinates. About three quarters of its entries carry no position at all, so an empty map here describes that metadata rather than radio.",
  unavailableTitle: "Radio stations unavailable",
};

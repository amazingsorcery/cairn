import type { SourceFeature } from "@/lib/sources/types";
import type { FeaturePrecision, LayerMedia, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, numberProp, stringProp } from "./props";

/**
 * Internet radio stations from the Radio Browser community catalogue. A registry of points,
 * not a live feed; the value is the detail panel.
 *
 * The browser connects to the broadcaster directly; we never relay audio (bandwidth, and the
 * catalogue's public-domain dedication doesn't cover the streams). We don't send the
 * catalogue's click telemetry, which would reveal which stations each reader opens.
 *
 * The `<audio>` element only mounts on press, with `preload="none"`.
 *
 * About 20% of working geolocated stations use plain `http:` (2,473 of 12,413, measured
 * 2026-08-31), which browsers silently block as mixed content. They're shown, with a link
 * out instead of a play button.
 *
 * Properties read (from `lib/sources/radio-browser.ts`):
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
 * --slate-300 #A8B9C9 and --slate-700 #2A3646, per `app/tokens.css`. Neutral because red
 * means destructive; a new layer will need a new primitive in `app/tokens.css`.
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

/** "plain http" or "https": whether the stream can play on this page. */
function streamSecurity(feature: SourceFeature): string | null {
  const insecure = boolProp(feature, "isInsecureStream");
  if (insecure === null) return null;
  return insecure ? "plain http" : "https";
}

function formatBitrate(feature: SourceFeature): string | null {
  const bitrate = numberProp(feature, "bitrateKbps");
  /* The catalogue uses 0 for "unknown"; treat it as missing. */
  if (bitrate === null || bitrate <= 0) return null;
  return `${NUMBER.format(Math.round(bitrate))} kbps`;
}

/**
 * Location caveat for every station: the coordinate is hand-entered in the catalogue,
 * usually a studio or city, and an internet stream has no coverage area.
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

/**
 * The stream as playable media, or a link out when it can't play here.
 *
 * Plain-`http:` streams are silently blocked as mixed content, so they get `kind: "link"`:
 * a top-level navigation in a new tab, which works.
 *
 * `credit` is null: the catalogue is public domain (credited in the status row), and we
 * don't invent a credit for the station's audio.
 */
function radioMedia(feature: SourceFeature): LayerMedia | null {
  const url = stringProp(feature, "streamUrl");
  if (url === null) return null;

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  if (boolProp(feature, "isInsecureStream") === true) {
    return {
      kind: "link",
      url,
      host,
      disclosure:
        `This station publishes its stream over plain http, which a browser will not play ` +
        `inside a secure page — it blocks it and reports nothing, so a play button here would ` +
        `do nothing at all. Opening it in a new tab works: your browser connects straight to ` +
        `${host}, which will see your IP address. Nothing about the audio passes through us.`,
      credit: null,
    };
  }

  /*
   * HLS (~1 in 15 stations) can't play in a plain `<audio>` on Chrome/Firefox, so it goes
   * through the HLS player with `medium: "audio"`.
   *
   * Outside Safari this needs `connect-src` for the broadcaster's origin, and the catalogue's
   * hosts are an open set that can't be allow-listed. Until the CSP allows it, the player
   * shows a "can't play here" message with a link out.
   */
  const kind = boolProp(feature, "isHls") === true ? "stream" : "audio";

  if (kind === "stream") {
    return {
      kind: "stream",
      url,
      host,
      medium: "audio",
      disclosure:
        `This station publishes a live HLS stream. Opening it connects your browser directly ` +
        `to ${host}, the broadcaster's own host rather than ours, and it will see your IP ` +
        `address for as long as the player is open. We never relay the audio, and we do not ` +
        `report to the catalogue which stations you open.`,
      credit: null,
    };
  }

  return {
    kind: "audio",
    url,
    host,
    disclosure:
      `Playing connects your browser directly to ${host}, the broadcaster's own host rather ` +
      `than ours, and it will see your IP address. We never relay the audio, and we do not ` +
      `report to the catalogue which stations you open.`,
    credit: null,
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
      /* Hollow = plain-http stream that won't play here (also stated in the table). */
      getFillColor: (f) => (boolProp(f, "isInsecureStream") === true ? [0, 0, 0, 0] : input.colour),
      getRadius: 5.5,
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1.5),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /* Stations don't move; nothing to animate. */
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
    /* Text, not a link, so connecting is always a deliberate choice. */
    { label: "Stream URL", value: (f) => stringProp(f, "streamUrl"), mono: true },
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

  media: radioMedia,

  defaultSort: { key: "station", direction: "asc" },

  emptyMessage:
    "The catalogue answered and listed no stations with coordinates. About three quarters of its entries carry no position at all, so an empty map here describes that metadata rather than radio.",
  unavailableTitle: "Radio stations unavailable",
};

import { z } from "zod";

import brand from "@/config/brand";

import { coordinatePair } from "../adapter";
import { FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN } from "./origins";
import { defineCameraProvider } from "./provider";
import type { CameraRecord } from "./provider";

/**
 * Fintraffic Digitraffic — the full national road weather camera catalogue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — read 2026-09-01. Full record in `docs/sources/fintraffic-weathercams.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence     Creative Commons Attribution 4.0. Declared in Digitraffic's own OpenAPI
 *             document (`license: {name: "Creative Commons 4.0 BY"}`) and on their terms
 *             page. Redistribution and commercial use are explicit.
 * Credit      Mandatory, verbatim: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"
 * Rate limit  Published, and numeric: 60 requests per minute per IP address for the general
 *             interfaces without the `Digitraffic-User` header, and 60/min for weather
 *             camera images. Exceeding it returns 429. Sending `Digitraffic-User` raises the
 *             ceiling, so we send it.
 * Compression **Mandatory**: "The use of compression is mandatory on all interfaces except
 *             for weather camera images", and a request without it is answered 406. So
 *             `accept-encoding: gzip` is not a courtesy here, it is a condition of use.
 * Polling     "Most of the service calls are cached... there is no gain calling the services
 *             too often". The station catalogue changes on the scale of weeks; our TTL is
 *             hours. One call per refresh.
 * Key         None.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MEDIA. **Stills only, and we say so rather than inventing a video URL.** Digitraffic's
 * road-traffic documentation describes exactly one media form: "For example preset image
 * C1451601 is located at https://weathercam.digitraffic.fi/C1451601.jpg", updated
 * "approximately about every 10 minutes". There is no MP4, no HLS and no DASH endpoint for
 * weathercams in their OpenAPI document, so `video` and `stream` are null.
 *
 * ONE FEATURE PER PRESET, NOT PER STATION. A station is a mast; a preset is a camera view
 * with its own image URL, and the 2026-09-01 catalogue has 812 stations carrying 2,279
 * presets. Collapsing them to one dot per station would throw away two thirds of the
 * published views and pick one arbitrarily.
 *
 * WHAT THE LIST ENDPOINT DOES NOT CARRY. `presentationName` ("Inkooseen"), `direction`,
 * `municipality` and the English station name live only on the per-station detail endpoint,
 * `/api/weathercam/v1/stations/{id}`. Reading them for the whole network would be 812 extra
 * requests against a 60/min ceiling on a catalogue that changes monthly — which is precisely
 * the "no gain calling the services too often" their instructions warn about. So a preset is
 * labelled with the station's own name and the preset's own number, both of which are facts
 * in the payload, and no direction is inferred from the id.
 */

const API_BASE = "https://tie.digitraffic.fi/api/weathercam/v1/stations";

/**
 * The documented image host and filename pattern:
 * "For example preset image C1451601 is located at
 * https://weathercam.digitraffic.fi/C1451601.jpg" — digitraffic.fi/en/road-traffic/,
 * read 2026-09-01, and confirmed against the `imageUrl` the detail endpoint returns.
 */
const IMAGE_BASE = FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN;

export const FINTRAFFIC_WEATHERCAMS_SLUG = "fintraffic-weathercams";

const presetSchema = z.object({
  id: z.string(),
  inCollection: z.boolean(),
});

const stationSchema = z.object({
  type: z.literal("Feature"),
  id: z.string(),
  geometry: z.object({
    type: z.literal("Point"),
    /** GeoJSON order: longitude, latitude, and a third element that is always 0 here. */
    coordinates: z.array(z.number()).min(2),
  }),
  properties: z.object({
    id: z.string(),
    name: z.string(),
    /** `GATHERING` or `REMOVED_TEMPORARILY` in the 2026-09-01 capture. */
    collectionStatus: z.string(),
    dataUpdatedTime: z.string().nullable().optional(),
    presets: z.array(presetSchema),
  }),
});

export const fintrafficWeathercamsSchema = z.object({
  type: z.literal("FeatureCollection"),
  /** When Fintraffic last updated the catalogue. Their clock, not ours. */
  dataUpdatedTime: z.string().nullable().optional(),
  features: z.array(stationSchema),
});

type Station = z.infer<typeof stationSchema>;

/**
 * "Weather camera images are updated approximately about every 10 minutes."
 * — digitraffic.fi/en/road-traffic/, read 2026-09-01.
 */
const STILL_REFRESH_SECONDS = 600;

/**
 * `kt51_Inkoo` -> `kt51 Inkoo`.
 *
 * Underscores are the operator's field separator, not part of the name. Nothing else is
 * changed: the road-class abbreviations (`kt` kantatie, `vt` valtatie, `st` seututie) are
 * left as Fintraffic writes them rather than expanded, because expanding them would be us
 * translating an operator's label and getting it wrong somewhere in 812 stations.
 */
function readableName(name: string): string {
  return name.replace(/_/g, " ").trim();
}

/**
 * The preset's own number within its station: `C0150301` on station `C01503` -> `01`.
 *
 * Returns null when the preset id does not extend the station id, in which case the full
 * preset id is used instead. No meaning is read out of the digits — Digitraffic documents a
 * `directionCode` on the *detail* endpoint and it is not in this payload, so inferring
 * "towards Inkoo" from an id would be inventing a fact about which way a camera points.
 */
function presetOrdinal(stationId: string, presetId: string): string | null {
  if (!presetId.startsWith(stationId) || presetId.length <= stationId.length) return null;
  return presetId.slice(stationId.length);
}

/**
 * Ids reach a URL, so they are checked against the shape Fintraffic issues.
 *
 * Nothing from a user request gets here — these come from Digitraffic's own response — but a
 * URL built by concatenating an upstream string is the shape that becomes an SSRF the moment
 * somebody fetches it, and `sourceUrl` is rendered as a link a reader clicks.
 */
const STATION_OR_PRESET_ID = /^[A-Z0-9]{4,16}$/;

function recordsForStation(station: Station): readonly CameraRecord[] {
  const [longitude, latitude] = station.geometry.coordinates;
  const position = coordinatePair(longitude, latitude);
  if (!position) return [];

  const stationId = station.properties.id;
  const name = readableName(station.properties.name);
  /*
   * `REMOVED_TEMPORARILY` is Fintraffic saying the station is out. Kept and flagged rather
   * than dropped, for the same reason as TfL's `available: false`: a count that quietly
   * disagrees with the operator's catalogue is the silent cap this build keeps meeting.
   */
  const stationGathering = station.properties.collectionStatus === "GATHERING";

  const records: CameraRecord[] = [];
  for (const preset of station.properties.presets) {
    if (!STATION_OR_PRESET_ID.test(preset.id)) continue;
    const ordinal = presetOrdinal(stationId, preset.id);

    records.push({
      id: preset.id,
      name: ordinal === null ? `${name} (${preset.id})` : `${name} (view ${ordinal})`,
      /*
       * The station name and the country. Fintraffic's `municipality` and `province` are on
       * the detail endpoint only, so they are not claimed here — an empty precision is
       * better than a guessed municipality on 812 stations.
       */
      locationLabel: `${name}, Finland`,
      latitude: position.latitude,
      longitude: position.longitude,
      /* The station's own API record, which is where a reader gets the full detail. */
      sourceUrl: STATION_OR_PRESET_ID.test(stationId) ? `${API_BASE}/${stationId}` : API_BASE,
      subject: "road weather",
      available: stationGathering && preset.inCollection,
      media: {
        still: { url: `${IMAGE_BASE}/${preset.id}.jpg`, refreshSeconds: STILL_REFRESH_SECONDS },
        /* Digitraffic publishes no video and no stream for weathercams. Stated, not guessed. */
        video: null,
        stream: null,
      },
    });
  }
  return records;
}

export const fintrafficWeathercams = defineCameraProvider({
  slug: FINTRAFFIC_WEATHERCAMS_SLUG,
  name: "Fintraffic Digitraffic (road weather cameras)",
  operator: "Fintraffic Oy",
  jurisdiction: "FI",
  catalogueUrl: API_BASE,
  /**
   * Compression is a condition of use on this API (406 without it), and `Digitraffic-User`
   * is the identification header their instructions ask for — it also raises the per-IP
   * ceiling above 60/min. It names the application and carries no user information.
   *
   * The name comes from `config/brand.ts` (product-brief §7 — renaming the product is a
   * one-file change, and that includes the string we introduce ourselves to an operator with).
   */
  headers: { "accept-encoding": "gzip", "digitraffic-user": `${brand.nameLower}-live` },
  /** 466 KB uncompressed on 2026-09-01. The default 8s budget is tight for that over gzip. */
  timeoutMs: 15_000,
  termsUrl: "https://www.digitraffic.fi/en/terms-of-service/",
  licence: "CC BY 4.0",
  attribution: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
  attributionRequired: true,
  stillImageOrigins: [FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN],
  schema: fintrafficWeathercamsSchema,

  records(data) {
    const records: CameraRecord[] = [];
    for (const station of data.features) records.push(...recordsForStation(station));
    return records;
  },

  /**
   * Fintraffic's own `dataUpdatedTime` — their clock, not ours — falling back to the read.
   * This is the honest thing to prefer: it is the operator stating when the catalogue was
   * produced, which is exactly what `observedAt` asks for.
   */
  observedAt(data, receivedAt) {
    if (!data.dataUpdatedTime) return receivedAt;
    const at = Date.parse(data.dataUpdatedTime);
    return Number.isNaN(at) ? receivedAt : new Date(at);
  },
});

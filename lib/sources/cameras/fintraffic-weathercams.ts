import { z } from "zod";

import brand from "@/config/brand";

import { coordinatePair } from "../adapter";
import { FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN } from "./origins";
import { defineCameraProvider } from "./provider";
import type { CameraRecord } from "./provider";

/**
 * Fintraffic Digitraffic — the full national road weather camera catalogue.
 *
 * Terms (checked 2026-09-01):
 * Licence     CC BY 4.0 (OpenAPI document and terms page).
 * Credit      Required verbatim: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"
 * Rate limit  60/min per IP without `Digitraffic-User` (429 beyond); we send the header.
 * Compression Mandatory except for images; requests without it get 406.
 * Polling     Catalogue changes over weeks; TTL is hours.
 * Key         None.
 *
 * Stills only: Digitraffic publishes no video or stream for weathercams.
 *
 * One feature per preset (camera view), not per station: 812 stations carry ~2,279 presets.
 *
 * Direction, municipality and presentation names are only on the per-station detail
 * endpoint; fetching them all would be 812 extra requests. Presets are labelled with the
 * station name and preset number instead, and no direction is inferred.
 */

const API_BASE = "https://tie.digitraffic.fi/api/weathercam/v1/stations";

/** Documented image pattern: `https://weathercam.digitraffic.fi/<presetId>.jpg`. */
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

/** Images update roughly every 10 minutes, per Digitraffic. */
const STILL_REFRESH_SECONDS = 600;

/** `kt51_Inkoo` -> `kt51 Inkoo`. Road-class abbreviations are left as-is. */
function readableName(name: string): string {
  return name.replace(/_/g, " ").trim();
}

/**
 * Preset number within its station: `C0150301` on `C01503` -> `01`. Null if the preset id
 * doesn't extend the station id. No direction is read from the digits.
 */
function presetOrdinal(stationId: string, presetId: string): string | null {
  if (!presetId.startsWith(stationId) || presetId.length <= stationId.length) return null;
  return presetId.slice(stationId.length);
}

/** Upstream ids are concatenated into URLs, so validate their shape first. */
const STATION_OR_PRESET_ID = /^[A-Z0-9]{4,16}$/;

function recordsForStation(station: Station): readonly CameraRecord[] {
  const [longitude, latitude] = station.geometry.coordinates;
  const position = coordinatePair(longitude, latitude);
  if (!position) return [];

  const stationId = station.properties.id;
  const name = readableName(station.properties.name);
  // `REMOVED_TEMPORARILY` stations are kept but flagged unavailable, so counts match the catalogue.
  const stationGathering = station.properties.collectionStatus === "GATHERING";

  const records: CameraRecord[] = [];
  for (const preset of station.properties.presets) {
    if (!STATION_OR_PRESET_ID.test(preset.id)) continue;
    const ordinal = presetOrdinal(stationId, preset.id);

    records.push({
      id: preset.id,
      name: ordinal === null ? `${name} (${preset.id})` : `${name} (view ${ordinal})`,
      // Municipality is only on the detail endpoint, so just station + country.
      locationLabel: `${name}, Finland`,
      latitude: position.latitude,
      longitude: position.longitude,
      /* The station's own API record, which is where a reader gets the full detail. */
      sourceUrl: STATION_OR_PRESET_ID.test(stationId) ? `${API_BASE}/${stationId}` : API_BASE,
      subject: "road weather",
      available: stationGathering && preset.inCollection,
      media: {
        still: { url: `${IMAGE_BASE}/${preset.id}.jpg`, refreshSeconds: STILL_REFRESH_SECONDS },
        /* No video or stream published for weathercams. */
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
   * gzip is required (406 without it). `Digitraffic-User` identifies the app (no user data),
   * raises the rate limit, and comes from `config/brand.ts`.
   */
  headers: { "accept-encoding": "gzip", "digitraffic-user": `${brand.nameLower}-live` },
  /** ~466 KB uncompressed; the default 8s is tight. */
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

  /** Fintraffic's `dataUpdatedTime`, falling back to the read time. */
  observedAt(data, receivedAt) {
    if (!data.dataUpdatedTime) return receivedAt;
    const at = Date.parse(data.dataUpdatedTime);
    return Number.isNaN(at) ? receivedAt : new Date(at);
  },
});

import { z } from "zod";

import { coordinatePair } from "../adapter";
import { TFL_JAMCAMS_IMAGE_ORIGIN } from "./origins";
import { defineCameraProvider } from "./provider";
import type { CameraRecord } from "./provider";

/**
 * Transport for London — JamCams, the full live catalogue from the Unified API.
 *
 * Terms (checked 2026-09-01):
 * Licence     TfL transport data service terms: worldwide, royalty-free, perpetual,
 *             non-exclusive, subject to conditions.
 * Credit      Required verbatim (see `attribution` below).
 * Conditions  No additional branding and no cropping, so the UI shows frames whole with
 *             nothing overlaid.
 * Rate limit  500 calls/min per feed; we make one call per catalogue refresh (hours).
 * Key         Not needed at our volume.
 *
 * Media: `imageUrl` is a still refreshed about every 3 minutes; `videoUrl` is a short MP4
 * file with undocumented cadence (not a live stream). No HLS/DASH.
 *
 * Cameras with `available: "false"` (~10%) are kept and flagged, not dropped.
 */

const PLACE_BASE = "https://api.tfl.gov.uk/Place";

/** Documented endpoint for all JamCam places. */
const CATALOGUE_URL = `${PLACE_BASE}/Type/JamCam`;

export const TFL_JAMCAMS_SLUG = "tfl-jamcams";

/** Only the fields we read; unknown keys are stripped, so added fields don't break us. */
const additionalPropertySchema = z.object({
  category: z.string(),
  key: z.string(),
  value: z.string(),
  /** ISO instant. TfL sets it per property; the newest is this record's age. */
  modified: z.string().optional(),
});

const jamCamSchema = z.object({
  id: z.string(),
  commonName: z.string(),
  lat: z.number(),
  lon: z.number(),
  additionalProperties: z.array(additionalPropertySchema),
});

export const tflJamCamsSchema = z.array(jamCamSchema);

type JamCam = z.infer<typeof jamCamSchema>;

/** The first `additionalProperties` entry with this key, or null. */
function property(place: JamCam, key: string): string | null {
  for (const entry of place.additionalProperties) {
    if (entry.key === key) return entry.value;
  }
  return null;
}

/** TfL's documented still refresh: every three minutes, sometimes more often. */
const STILL_REFRESH_SECONDS = 180;

/** Unified API URL for one camera. The upstream id is shape-checked before concatenation. */
function placeUrl(id: string): string {
  return /^JamCams_[0-9.]{1,32}$/.test(id) ? `${PLACE_BASE}/${id}` : CATALOGUE_URL;
}

/** `JamCams_00001.07450` -> `00001.07450`, for a readable feature id. */
function shortId(id: string): string {
  return id.startsWith("JamCams_") ? id.slice("JamCams_".length) : id;
}

function toRecord(place: JamCam): CameraRecord | null {
  const position = coordinatePair(place.lon, place.lat);
  if (!position) return null;

  const imageUrl = property(place, "imageUrl");
  const videoUrl = property(place, "videoUrl");
  // Nothing to show.
  if (!imageUrl && !videoUrl) return null;

  const view = property(place, "view");

  return {
    id: shortId(place.id),
    name: place.commonName,
    // All JamCams are in London; the borough isn't in the payload.
    locationLabel: `${place.commonName}, London`,
    latitude: position.latitude,
    longitude: position.longitude,
    sourceUrl: placeUrl(place.id),
    // TfL's view text, e.g. "SOUTH - A24 jct Blackshaw Road".
    subject: view ?? "road traffic",
    available: property(place, "available") === "true",
    media: {
      still: imageUrl ? { url: imageUrl, refreshSeconds: STILL_REFRESH_SECONDS } : null,
      video: videoUrl
        ? {
            url: videoUrl,
            format: "mp4",
            // Undocumented for video, so null (not 180).
            refreshSeconds: null,
          }
        : null,
      // No live stream published.
      stream: null,
    },
  };
}

/**
 * Receipt time. TfL has no catalogue timestamp, and per-property `modified` is when that
 * record last changed, not when the catalogue was produced.
 */
function observedAtFrom(_places: readonly JamCam[], receivedAt: Date): Date {
  return receivedAt;
}

export const tflJamCams = defineCameraProvider({
  slug: TFL_JAMCAMS_SLUG,
  name: "Transport for London (JamCams)",
  operator: "Transport for London",
  jurisdiction: "GB",
  catalogueUrl: CATALOGUE_URL,
  termsUrl: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
  licence:
    "TfL transport data service terms — worldwide, royalty-free, perpetual, non-exclusive licence to use the information, subject to attribution; images must not be cropped or re-branded",
  attribution:
    "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016. Geomni UK Map data © and database rights [2019].",
  attributionRequired: true,
  /** Shared S3 endpoint; see `origins.ts`. */
  stillImageOrigins: [TFL_JAMCAMS_IMAGE_ORIGIN],
  schema: tflJamCamsSchema,

  records(data) {
    const records: CameraRecord[] = [];
    for (const place of data) {
      const record = toRecord(place);
      if (record) records.push(record);
    }
    return records;
  },

  observedAt: (data, receivedAt) => observedAtFrom(data, receivedAt),
});

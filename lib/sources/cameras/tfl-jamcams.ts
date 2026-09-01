import { z } from "zod";

import { coordinatePair } from "../adapter";
import { TFL_JAMCAMS_IMAGE_ORIGIN } from "./origins";
import { defineCameraProvider } from "./provider";
import type { CameraRecord } from "./provider";

/**
 * Transport for London — JamCams, the full live catalogue from the Unified API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — read 2026-09-01. Full record in `docs/sources/tfl-jamcams.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * Licence     TfL transport data service terms: "TfL grants You a worldwide, royalty-free,
 *             perpetual, non-exclusive Licence to use the Information subject to the
 *             conditions below."
 * Credit      Mandatory, three strings, rendered verbatim:
 *             "Powered by TfL Open Data. Contains OS data © Crown copyright and database
 *             rights 2016. Geomni UK Map data © and database rights [2019]."
 * Conditions  Two that bind this layer specifically, from TfL's open-data page:
 *               · "No additional branding (all TfL CCTV images already contain TfL branding)"
 *               · "You must not crop images"
 *             So the UI renders the frame whole and puts nothing over it. Recorded here
 *             because it is a licence condition on the *display*, which is a thing an
 *             adapter cannot enforce and must therefore hand on in writing.
 * Rate limit  "Limit traffic requests up to a maximum of 500 calls per minute per data
 *             feed." We make one call per catalogue refresh — see the TTL in
 *             `traffic-cameras.ts`, which is hours rather than minutes.
 * Key         None for this endpoint. `app_key` raises the ceiling and is not needed at our
 *             volume, so no secret is introduced.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MEDIA. Two forms, and they are **not** the same thing:
 *   · `imageUrl` — a still JPEG at a stable URL. TfL's open-data page: cameras are
 *     "refreshed every three minutes - sometimes more often".
 *   · `videoUrl` — a short MP4 **file** at a stable URL, returned by the Unified API for
 *     every JamCam. TfL's open-data page documents the stills and does not document the
 *     video's cadence, so `refreshSeconds` is null rather than a number we made up. It is a
 *     file that is rewritten, **not a live stream**, and `hasLiveStream` stays false.
 * TfL publishes no HLS or DASH manifest for JamCams.
 *
 * AVAILABILITY. TfL sets `available: "false"` on a minority of cameras — 88 of 890 in the
 * catalogue captured on 2026-09-01. Those are kept and flagged rather than dropped: the
 * images still resolve, and quietly returning 802 of an 890-camera catalogue is the silent
 * cap this build has been bitten by repeatedly.
 */

const PLACE_BASE = "https://api.tfl.gov.uk/Place";

/** The documented endpoint for every JamCam place. A module constant; nothing interpolates. */
const CATALOGUE_URL = `${PLACE_BASE}/Type/JamCam`;

export const TFL_JAMCAMS_SLUG = "tfl-jamcams";

/**
 * Exactly the fields we read, and nothing else.
 *
 * `$type`, `children`, `childrenUrls` and `placeType` are all present on the real payload and
 * all ignored; Zod strips unknown keys by default, so TfL adding a field is not a schema
 * change for us. What *would* be a schema change — `lat` becoming a string, or
 * `additionalProperties` disappearing — fails here and disables this provider alone.
 */
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

/**
 * "Refreshed every three minutes - sometimes more often" — TfL, `tfl.gov.uk/info-for/
 * open-data-users/our-open-data`, read 2026-09-01. Their number, not a measurement of ours.
 */
const STILL_REFRESH_SECONDS = 180;

/**
 * The Unified API record for one camera, built from its id.
 *
 * The id is checked against the shape TfL actually issues before it is put in a URL. Nothing
 * from a user request reaches here — the id comes from TfL's own response — but a URL built
 * by string concatenation from an upstream value is the shape that becomes an SSRF the
 * moment somebody decides to fetch it, and this one is rendered as a link a reader clicks.
 */
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
  // Every camera in the 2026-09-01 capture carried both. A record carrying neither has
  // nothing for a reader to open, so it is not a camera this layer can render.
  if (!imageUrl && !videoUrl) return null;

  const view = property(place, "view");

  return {
    id: shortId(place.id),
    name: place.commonName,
    /*
     * TfL's own name for the site, plus the city. Every JamCam is in Greater London — TfL's
     * open-data page describes "images from over 700 cameras across the capital" — and on a
     * world map the bare road reference "A406 Billet Upass E" locates nothing. Nothing
     * finer is invented: the borough is not in the payload, so it is not claimed.
     */
    locationLabel: `${place.commonName}, London`,
    latitude: position.latitude,
    longitude: position.longitude,
    sourceUrl: placeUrl(place.id),
    /*
     * TfL's own `cameraView` text — "SOUTH - A24 jct Blackshaw Road" — which is a far better
     * answer to "what does it look at" than a category. Falls back to the only thing we can
     * say without inventing one.
     */
    subject: view ?? "road traffic",
    available: property(place, "available") === "true",
    media: {
      still: imageUrl ? { url: imageUrl, refreshSeconds: STILL_REFRESH_SECONDS } : null,
      video: videoUrl
        ? {
            url: videoUrl,
            format: "mp4",
            /*
             * NOT 180. TfL documents the refresh interval for the images and says nothing
             * about the video, and the honest answer to a question the operator has not
             * answered is null. A number here would be read as their number.
             */
            refreshSeconds: null,
          }
        : null,
      /*
       * No live stream. TfL publishes no HLS or DASH manifest for JamCams, and the MP4 is a
       * file that gets rewritten. Calling that live would be a false claim about a
       * timestamp, which is exactly the distinction the three media forms exist to keep.
       */
      stream: null,
    },
  };
}

/**
 * The receipt time, deliberately.
 *
 * TfL publishes no catalogue-level timestamp. The per-property `modified` field is when TfL
 * last changed *that camera's record* — a camera nobody has touched for a month still carries
 * last month's stamp — so it answers "when did this entry change", not "when was this
 * catalogue produced". Reporting the layer as a month old because one field is would
 * understate freshness as badly as inventing a number would overstate it.
 *
 * What we can say honestly is that we read TfL's catalogue at this instant, which is what
 * `observedAt` means for a catalogue: `SourceResult.observedAt` is "when the upstream
 * produced this data", and for a live index that is the read.
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
  /** TfL's public S3 bucket. Shared infrastructure — see the note in `origins.ts`. */
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

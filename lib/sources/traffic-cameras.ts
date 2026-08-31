import { z } from "zod";

import { coordinatePair, parseWith, type NormaliseOutcome, type PollAdapter } from "./adapter";
import type { SourceFeature, SourceResult } from "./types";

import fintraffic from "@/content/cameras/fintraffic-digitraffic.json";
import linkOnly from "@/content/cameras/link-only-providers.json";
import tfl from "@/content/cameras/transport-for-london.json";

/**
 * Traffic and road cameras — served from v1's verified registry, not re-derived.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TERMS CHECK — inherited, and re-read 2026-08-31.
 * Full record in `docs/sources/traffic-cameras.md`.
 * ─────────────────────────────────────────────────────────────────────────────
 * v1 already did this work properly. `content/cameras/*.json` carries, per provider and per
 * camera: the licence, the exact attribution string, the terms URL, the rate-limit note, an
 * `embedPermitted` flag with the reasoning behind it, a `confidence` value and a
 * `lastVerifiedAt` date. Two providers were verified for embedding:
 *
 *   - **Transport for London (JamCams)** — TfL open data terms; a worldwide, royalty-free,
 *     perpetual licence to copy, publish, distribute and adapt. Attribution mandatory:
 *     "Powered by TfL Open Data..." Rate limit documented at 500 calls/minute per feed.
 *   - **Fintraffic Digitraffic** — CC BY 4.0, the cleanest licence in the registry.
 *     Attribution mandatory: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY".
 *     Images collect on a roughly 10-minute interval.
 *
 * A third file holds **link-only** providers: networks that are unambiguously published but
 * where v1 could not confirm an embed permission or a stable feed URL. Those are excluded
 * from this layer by default, which is the whole point of the distinction — see below.
 *
 * Rebuilding this from the operators' APIs would re-earn nothing and would risk contradicting
 * a licence reading that has already been made carefully and dated.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THIS ADAPTER MAKES NO OUTBOUND REQUEST. That is not a limitation, it is ADR 0015:
 *
 *   - Camera **images and video are never proxied**. `embedUrl` is handed to the client and
 *     the reader's browser connects to TfL's or Fintraffic's host directly, on an explicit
 *     click (ADR 0015 — click-to-load). Relaying the bytes would exhaust a small VPS and turn
 *     a linking site into a rebroadcasting one (product-brief §2b).
 *   - The camera **positions** are static registry content, not a live feed, so there is
 *     nothing to poll. `observedAt` is the registry's own `lastVerifiedAt` — the date a human
 *     actually checked — rather than the moment this function ran. Reporting "verified just
 *     now" for a fact checked in August would be the freshness lie ADR 0014 exists to prevent.
 *
 * Anything requiring a live call — enumerating TfL's full JamCam list, or Digitraffic's 470
 * stations — is a separate adapter with its own terms record, not a quiet extension of this
 * one.
 */

/* ------------------------------------------------------------------ *
 * Registry schema
 * ------------------------------------------------------------------ */

const cameraSchema = z.object({
  slug: z.string(),
  name: z.string(),
  operator: z.string(),
  jurisdiction: z.string(),
  locationLabel: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  sourceUrl: z.string(),
  embedUrl: z.string().nullable(),
  embedPermitted: z.boolean(),
  attributionRequired: z.boolean(),
  attribution: z.string().nullable(),
  licence: z.string(),
  subject: z.string(),
  confidence: z.string(),
  lastVerifiedAt: z.string(),
});

const providerFileSchema = z.object({
  provider: z
    .object({
      slug: z.string(),
      name: z.string(),
      attribution: z.string().nullable(),
      licence: z.string(),
    })
    .passthrough(),
  cameras: z.array(cameraSchema),
});

export const cameraRegistrySchema = z.array(providerFileSchema);

/**
 * The embedding-permitted registries only.
 *
 * `link-only-providers.json` is deliberately excluded. Those entries exist precisely because
 * an embed permission could NOT be confirmed, and putting them on a map layer that renders
 * embeds would undo the judgement that put them in a separate file. They belong on the
 * directory surface, where the reader knowingly navigates to the operator instead.
 */
const EMBEDDING_REGISTRIES: readonly unknown[] = [tfl, fintraffic];

/** Exported so a test can assert the exclusion is real rather than incidental. */
export const LINK_ONLY_REGISTRY: unknown = linkOnly;

/* ------------------------------------------------------------------ *
 * The normalised feature
 * ------------------------------------------------------------------ */

export interface CameraFeature extends SourceFeature {
  readonly kind: "cameras";
  readonly properties: {
    readonly operator: string;
    readonly jurisdiction: string;
    readonly locationLabel: string;
    /**
     * The image or video URL the CLIENT loads directly, on an explicit click. Never fetched
     * by our server. Null would mean the camera should not be on this layer at all.
     */
    readonly embedUrl: string;
    /** Per-camera credit. Rendered at the point of display; several licences require it. */
    readonly attribution: string | null;
    readonly attributionRequired: boolean;
    readonly licence: string;
    readonly subject: string;
    /** `verified` | `high` | `medium` | `needsReview`, per product-brief §6. */
    readonly confidence: string;
    /** When a human last confirmed this entry. Never back-dated to look fresher. */
    readonly lastVerifiedAt: string;
    readonly providerName: string;
  };
}

export function normaliseCameras(
  raw: unknown,
  receivedAt: Date = new Date(),
): NormaliseOutcome<CameraFeature> {
  const parsed = parseWith(cameraRegistrySchema, raw);
  if (!parsed.ok) return parsed;

  const features: CameraFeature[] = [];
  let newestVerification: number | null = null;

  for (const file of parsed.data) {
    for (const camera of file.cameras) {
      // A camera we may not embed has no business on an embedding layer, whatever file it
      // arrived in. Belt and braces over the registry split.
      if (!camera.embedPermitted || !camera.embedUrl) continue;

      const position = coordinatePair(camera.longitude, camera.latitude);
      if (!position) continue;

      const verifiedAt = Date.parse(camera.lastVerifiedAt);
      if (!Number.isNaN(verifiedAt)) {
        newestVerification = Math.max(newestVerification ?? verifiedAt, verifiedAt);
      }

      features.push({
        id: camera.slug,
        kind: "cameras",
        longitude: position.longitude,
        latitude: position.latitude,
        label: camera.name,
        sourceUrl: camera.sourceUrl,
        properties: {
          operator: camera.operator,
          jurisdiction: camera.jurisdiction,
          locationLabel: camera.locationLabel,
          embedUrl: camera.embedUrl,
          attribution: camera.attribution ?? file.provider.attribution,
          attributionRequired: camera.attributionRequired,
          licence: camera.licence,
          subject: camera.subject,
          confidence: camera.confidence,
          lastVerifiedAt: camera.lastVerifiedAt,
          providerName: file.provider.name,
        },
      });
    }
  }

  return {
    ok: true,
    features,
    /**
     * The date a human last checked, not the moment this ran. See the note at the top: a
     * static registry that reports itself as freshly observed is lying about its own age.
     */
    observedAt: newestVerification === null ? receivedAt : new Date(newestVerification),
  };
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export const TRAFFIC_CAMERAS_SLUG = "traffic-cameras";

export const trafficCameras: PollAdapter<CameraFeature> = {
  slug: TRAFFIC_CAMERAS_SLUG,
  name: "Traffic and road cameras",
  kind: "cameras",
  homepage: "https://www.digitraffic.fi/en/",
  attribution: {
    /**
     * The layer-level credit names both operators, because this layer mixes two providers
     * under two different licences. The PER-CAMERA attribution in `properties.attribution` is
     * the one that satisfies each licence at the point of display — TfL's terms require their
     * exact wording including the Ordnance Survey notice, and CC BY requires Fintraffic's.
     * A single blended string would satisfy neither.
     */
    text: "Camera data: Transport for London (Powered by TfL Open Data) and Fintraffic / digitraffic.fi (CC BY 4.0)",
    href: "https://www.digitraffic.fi/en/terms-of-service/",
    licence: "TfL open data terms; CC BY 4.0 (per camera — see each feature)",
  },
  /** Product-brief §2b: webcam metadata ~1h. Nothing is fetched, so this is a re-read floor. */
  ttlSeconds: 3600,
  responseSchema: cameraRegistrySchema,
  normalise: normaliseCameras,

  fetch(_signal: AbortSignal): Promise<SourceResult<CameraFeature>> {
    // No network call. See the note at the top of this file — this is ADR 0015, not an
    // unfinished implementation.
    const normalised = normaliseCameras(EMBEDDING_REGISTRIES, new Date());
    if (!normalised.ok) {
      // Only reachable if the committed registry itself stops matching its schema, which is a
      // build-time mistake rather than an upstream one — but it still degrades one layer
      // instead of throwing into the worker.
      return Promise.resolve({ ok: false, failure: normalised.failure, lastGoodAt: null });
    }
    return Promise.resolve({
      ok: true,
      features: normalised.features,
      observedAt: normalised.observedAt,
      stale: false,
    });
  },

  async healthcheck(signal: AbortSignal) {
    const result = await trafficCameras.fetch(signal);
    return result.ok
      ? { ok: true, detail: `${result.features.length} embeddable cameras in the registry` }
      : { ok: false, detail: "camera registry does not match its schema" };
  },
};

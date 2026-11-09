import type { z } from "zod";

import type { SourceFeature } from "../types";

/**
 * The camera-provider seam.
 *
 * One cameras adapter over N providers, since the map has a single cameras layer but each
 * operator has its own catalogue and licence. Attribution therefore travels per feature, and a
 * failing provider only takes itself off the map.
 *
 * Media comes in three forms kept separate: still image, periodically regenerated video file
 * (not live), and live HLS/DASH stream. `refreshSeconds` is null unless the operator
 * documents it.
 *
 * We only fetch the catalogue. Media URLs go to the client, which loads them from the
 * operator on an explicit press; relaying imagery would cost too much bandwidth and make us a
 * rebroadcaster.
 */

/** The three forms a camera's media can take. Order is least to most live. */
export const CAMERA_MEDIA_FORMS = ["still", "video", "stream"] as const;
export type CameraMediaForm = (typeof CAMERA_MEDIA_FORMS)[number];

/** A still image rewritten in place. `refreshSeconds` is the operator's documented interval or null. */
export interface CameraStill {
  readonly url: string;
  readonly refreshSeconds: number | null;
}

/** A video file regenerated periodically (e.g. TfL JamCam MP4s). Not a live stream. */
export interface CameraVideo {
  readonly url: string;
  /** Container/codec family as the operator publishes it, e.g. `mp4`. */
  readonly format: string;
  readonly refreshSeconds: number | null;
}

/** A genuinely live stream — an HLS or DASH manifest the player follows as it extends. */
export interface CameraStream {
  readonly url: string;
  /** `hls` or `dash`. Named so a player can choose without sniffing the extension. */
  readonly format: "hls" | "dash";
}

export interface CameraMediaSet {
  readonly still: CameraStill | null;
  readonly video: CameraVideo | null;
  readonly stream: CameraStream | null;
}

/** Which forms are actually present, in the fixed order above. */
export function mediaFormsOf(media: CameraMediaSet): readonly CameraMediaForm[] {
  const forms: CameraMediaForm[] = [];
  if (media.still) forms.push("still");
  if (media.video) forms.push("video");
  if (media.stream) forms.push("stream");
  return forms;
}

/** One camera, provider-neutral. `toCameraFeature` adds provider-level licence and credit. */
export interface CameraRecord {
  /** Unique within the provider. Prefixed with the provider slug to build the feature id. */
  readonly id: string;
  /** Short label for the map and the table row. */
  readonly name: string;
  /** Human-readable location, as the operator describes it. Never geocoded by us. */
  readonly locationLabel: string;
  readonly latitude: number;
  readonly longitude: number;
  /** The operator's own page or API record for this camera, so a reader can get to origin. */
  readonly sourceUrl: string;
  /** What the camera looks at, in the operator's words where they publish them. */
  readonly subject: string;
  /** Operator's availability flag. Unavailable cameras are kept so counts match the catalogue. */
  readonly available: boolean;
  readonly media: CameraMediaSet;
}

/** Everything about a provider that is not its payload handling. */
export interface CameraProviderIdentity {
  /** Matches the provider's `connectors` slug. */
  readonly slug: string;
  /** Shown to the reader as the network name, e.g. "Transport for London (JamCams)". */
  readonly name: string;
  readonly operator: string;
  /** ISO 3166 alpha-2, or a subdivision code where the operator is sub-national. */
  readonly jurisdiction: string;
  /** The catalogue endpoint. A module constant — nothing from a request reaches it. */
  readonly catalogueUrl: string;
  /** Extra request headers the operator's documentation requires or asks for. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly termsUrl: string;
  readonly licence: string;
  /** The exact credit the licence requires, rendered verbatim at the point of display. */
  readonly attribution: string;
  readonly attributionRequired: boolean;
  /**
   * Origins for this provider's still images, for the CSP `img-src` allowlist (a missing one
   * is blocked only in production). Video/audio need no entry.
   */
  readonly stillImageOrigins: readonly string[];
}

/**
 * What a provider file writes: identity, a Zod schema, and mappers over the typed payload.
 * Kept separate so mapping can be tested against a captured payload offline.
 */
export interface CameraProviderSpec<S extends z.ZodTypeAny> extends CameraProviderIdentity {
  readonly schema: S;
  /** Map an already-validated catalogue to records. */
  records(data: z.output<S>): readonly CameraRecord[];
  /** When the operator produced this catalogue, if they say; otherwise the receipt time. */
  observedAt(data: z.output<S>, receivedAt: Date): Date;
}

/** A schema mismatch, named with the provider that changed shape. */
export interface CameraProviderSchemaFailure {
  readonly kind: "schemaChanged";
  readonly message: string;
}

export type CameraProviderRead =
  | { readonly ok: true; readonly records: readonly CameraRecord[]; readonly observedAt: Date }
  | { readonly ok: false; readonly failure: CameraProviderSchemaFailure };

/**
 * Registry entry: identity plus a non-generic `read`. The generic is closed over in
 * `defineCameraProvider`, since `z.output<z.ZodTypeAny>` is `any`.
 */
export interface CameraProvider extends CameraProviderIdentity {
  /** Exposed so the adapter can compose one `responseSchema` and a test can assert shape. */
  readonly schema: z.ZodTypeAny;
  /** Validate a raw catalogue and map it, or say which provider stopped matching. */
  read(raw: unknown, receivedAt: Date): CameraProviderRead;
}

/**
 * Build the registry entry. Parsing happens only here, so a mismatch is a typed failure
 * naming the provider, never a throw.
 */
export function defineCameraProvider<S extends z.ZodTypeAny>(
  spec: CameraProviderSpec<S>,
): CameraProvider {
  return {
    slug: spec.slug,
    name: spec.name,
    operator: spec.operator,
    jurisdiction: spec.jurisdiction,
    catalogueUrl: spec.catalogueUrl,
    ...(spec.headers === undefined ? {} : { headers: spec.headers }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes }),
    termsUrl: spec.termsUrl,
    licence: spec.licence,
    attribution: spec.attribution,
    attributionRequired: spec.attributionRequired,
    stillImageOrigins: spec.stillImageOrigins,
    schema: spec.schema,
    read(raw, receivedAt) {
      const parsed = spec.schema.safeParse(raw);
      if (!parsed.success) {
        // Paths only: the full Zod message embeds upstream strings.
        const paths = parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`)
          .join("; ");
        return {
          ok: false,
          failure: {
            kind: "schemaChanged",
            message: `${spec.slug} payload did not match the expected schema (${paths})`,
          },
        };
      }
      const data = parsed.data;
      return { ok: true, records: spec.records(data), observedAt: spec.observedAt(data, receivedAt) };
    },
  };
}

/**
 * A camera on the map. `properties` must be flat scalars, so media forms are flattened; every
 * key is always present, with `null` for a missing form.
 */
export interface CameraFeature extends SourceFeature {
  readonly kind: "cameras";
  readonly properties: {
    readonly operator: string;
    readonly providerName: string;
    readonly providerSlug: string;
    readonly jurisdiction: string;
    readonly locationLabel: string;
    readonly subject: string;
    readonly licence: string;
    /** Per-camera credit. Rendered at the point of display; several licences require it. */
    readonly attribution: string | null;
    readonly attributionRequired: boolean;
    /** `verified` | `high` | `medium` | `needsReview`. */
    readonly confidence: string;
    /** ISO date this record was last confirmed against the operator. Never back-dated. */
    readonly lastVerifiedAt: string;
    /** The operator's own flag. False means they say this camera is currently out. */
    readonly available: boolean;

    /** Same as `stillUrl`; kept for `components/map/registry/cameras.ts`. Prefer `stillUrl`. */
    readonly embedUrl: string | null;

    /** The still image the client loads directly, or null if this camera publishes none. */
    readonly stillUrl: string | null;
    /** The operator's documented still interval in seconds, or null if they publish none. */
    readonly stillRefreshSeconds: number | null;

    /** A video FILE, regenerated periodically. Not live. Never labelled as live. */
    readonly videoUrl: string | null;
    readonly videoFormat: string | null;
    readonly videoRefreshSeconds: number | null;

    /** A genuinely live stream manifest, or null. */
    readonly streamUrl: string | null;
    readonly streamFormat: string | null;

    /** Comma-joined subset of `still,video,stream`. Empty string is impossible by rule. */
    readonly mediaForms: string;
    /** True only when `streamUrl` is set; check before labelling anything "live". */
    readonly hasLiveStream: boolean;
  };
}

/** Build the feature for one record. Returns null when the record carries no media at all. */
export function toCameraFeature(
  provider: CameraProvider,
  record: CameraRecord,
  options: { readonly lastVerifiedAt: string; readonly confidence: string },
): CameraFeature | null {
  const forms = mediaFormsOf(record.media);
  // Nothing to show, so nothing to put on the layer.
  if (forms.length === 0) return null;

  const still = record.media.still;
  const video = record.media.video;
  const stream = record.media.stream;

  return {
    id: `${provider.slug}:${record.id}`,
    kind: "cameras",
    longitude: record.longitude,
    latitude: record.latitude,
    label: record.name,
    sourceUrl: record.sourceUrl,
    // Operator-published coordinates. A provider with derived positions must set this.
    precision: null,
    properties: {
      operator: provider.operator,
      providerName: provider.name,
      providerSlug: provider.slug,
      jurisdiction: provider.jurisdiction,
      locationLabel: record.locationLabel,
      subject: record.subject,
      licence: provider.licence,
      attribution: provider.attribution,
      attributionRequired: provider.attributionRequired,
      confidence: options.confidence,
      lastVerifiedAt: options.lastVerifiedAt,
      available: record.available,

      embedUrl: still?.url ?? null,

      stillUrl: still?.url ?? null,
      stillRefreshSeconds: still?.refreshSeconds ?? null,

      videoUrl: video?.url ?? null,
      videoFormat: video?.format ?? null,
      videoRefreshSeconds: video?.refreshSeconds ?? null,

      streamUrl: stream?.url ?? null,
      streamFormat: stream?.format ?? null,

      mediaForms: forms.join(","),
      hasLiveStream: stream !== null,
    },
  };
}

/** The date part of an instant, for `lastVerifiedAt`. A verification is a date, not a clock. */
export function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

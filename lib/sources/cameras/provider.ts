import type { z } from "zod";

import type { SourceFeature } from "../types";

/**
 * The camera-provider seam.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SEAM INSIDE ONE ADAPTER, RATHER THAN ONE ADAPTER PER OPERATOR
 * ─────────────────────────────────────────────────────────────────────────────
 * `SourceAdapter` is one upstream, one licence, one registry row. Cameras are the one kind
 * where that does not fit: a dozen national road authorities each publish their own
 * catalogue under their own licence, and the map registry has **one** cameras layer. Making
 * each operator its own `SourceAdapter` would require a new layer in
 * `components/map/registry/` per operator — which is exactly the "adding a source must never
 * require touching the map component" rule, failing from the other direction.
 *
 * So the layer is one adapter over N providers. What that costs is that the adapter's
 * `attribution` and its `connectors` row describe a mixture, and the honest per-operator
 * credit has to travel **per feature** — which it already did, because TfL's licence and
 * CC BY cannot share one string. What it buys is that a provider is a file in this directory
 * plus one entry in an array, with its own terms record in `docs/sources/<slug>.md`, and a
 * provider whose upstream changes shape or goes down takes **only itself** off the map.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEDIA: THREE FORMS, NAMED SEPARATELY, NEVER CONFLATED
 * ─────────────────────────────────────────────────────────────────────────────
 * A JPEG the operator rewrites every three minutes, a short MP4 the operator regenerates on
 * the same cycle, and a genuine HLS manifest are three different things to an investigator
 * reading a timestamp. **A clip refreshed every few minutes is not a live stream**, and
 * collapsing them into one `embedUrl` forces the UI to guess which it is holding.
 *
 * So a camera carries up to three forms, each explicitly present or explicitly absent, each
 * with the operator's own documented cadence where the operator publishes one. Nothing is
 * inferred: `refreshSeconds` is `null` when the provider does not say, and a `null` is a
 * better answer than a plausible number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NONE OF THESE URLS IS EVER FETCHED BY US
 * ─────────────────────────────────────────────────────────────────────────────
 * Product-brief §2b and ADR 0015. The adapter fetches the **catalogue** — small JSON saying
 * which cameras exist and where — and hands the media URLs to the client, which connects to
 * the operator directly on an explicit press. Relaying the imagery would exhaust this
 * deployment's bandwidth (docs/deploy/RUNBOOK.md §21) and turn a linking site into a
 * rebroadcasting one, which is a different legal posture entirely.
 */

/** The three forms a camera's media can take. Order is least to most live. */
export const CAMERA_MEDIA_FORMS = ["still", "video", "stream"] as const;
export type CameraMediaForm = (typeof CAMERA_MEDIA_FORMS)[number];

/**
 * A single still image, rewritten in place by the operator.
 *
 * `refreshSeconds` is the operator's own documented interval, or `null`. It is not measured
 * and not guessed: a reader deciding whether they are looking at ten seconds ago or ten
 * minutes ago needs the operator's number or an honest absence.
 */
export interface CameraStill {
  readonly url: string;
  readonly refreshSeconds: number | null;
}

/**
 * A video **file** the operator regenerates periodically. NOT a live stream.
 *
 * TfL's JamCams are the canonical example: a short MP4 at a stable URL, rewritten on roughly
 * the same cycle as the still. Playing it shows a few seconds of the recent past on a loop.
 * Labelling that "live" would be a specific false claim about a timestamp.
 */
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

/**
 * One camera, provider-neutral, before it becomes a map feature.
 *
 * A provider produces these; `toCameraFeature` below adds the licence, the credit and the
 * operator, which are properties of the provider rather than of the individual camera.
 */
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
  /**
   * The operator's own availability flag.
   *
   * Cameras the operator marks unavailable are **kept**, not dropped. Dropping them would
   * make our count disagree with the operator's catalogue with nothing on screen to say so,
   * which is the silent-cap failure this build keeps meeting. The UI is told instead.
   */
  readonly available: boolean;
  readonly media: CameraMediaSet;
}

/** Everything about a provider that is not its payload handling. */
export interface CameraProviderIdentity {
  /** Matches `docs/sources/<slug>.md`. */
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
   * Every origin this provider's **still images** can come from.
   *
   * `img-src` is an allowlist, so a still on a host the CSP does not name is silently
   * blocked in production and works fine in development. Declared here rather than derived
   * from a URL at runtime, so `scripts/generate-csp.ts` can read it without a network call.
   * Video and audio are covered by `media-src 'self' https:` and need no entry.
   */
  readonly stillImageOrigins: readonly string[];
}

/**
 * What a provider file writes: identity, a Zod schema, and two functions over the *typed*
 * payload.
 *
 * `schema` and `records` are separate for the same reason `SourceAdapter` separates
 * `responseSchema` from `normalise` — the mapping is tested against a captured real payload
 * with no network, which is the test that actually catches an upstream shape change.
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
 * What the registry holds: identity plus one non-generic `read`.
 *
 * The generic parameter is closed over inside `defineCameraProvider` rather than leaked into
 * the registry type. `z.output<z.ZodTypeAny>` is `any`, so a generic registry entry would put
 * `any` back into every call site — the thing `unknown` plus narrowing exists to avoid.
 */
export interface CameraProvider extends CameraProviderIdentity {
  /** Exposed so the adapter can compose one `responseSchema` and a test can assert shape. */
  readonly schema: z.ZodTypeAny;
  /** Validate a raw catalogue and map it, or say which provider stopped matching. */
  read(raw: unknown, receivedAt: Date): CameraProviderRead;
}

/**
 * Close a spec's generic parameter and produce the registry entry.
 *
 * The Zod parse happens here and only here, so every provider degrades the same way: a
 * mismatch is a typed value naming this provider, never a throw, and never the whole layer.
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
        /*
         * Failing PATHS only, never the parsed values. The full Zod message embeds the
         * upstream's own strings, and those reach a log line and an operator's screen.
         */
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
 * A camera on the map.
 *
 * `properties` is flat by contract (`SourceFeature.properties` is a record of scalars), so
 * the three media forms are flattened rather than nested. Every key is present on every
 * feature — a missing form is an explicit `null`, not an absent key — because a UI that has
 * to distinguish "no video" from "this provider does not set that field" will get it wrong.
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
    /** `verified` | `high` | `medium` | `needsReview`, per product-brief §6. */
    readonly confidence: string;
    /** ISO date this record was last confirmed against the operator. Never back-dated. */
    readonly lastVerifiedAt: string;
    /** The operator's own flag. False means they say this camera is currently out. */
    readonly available: boolean;

    /**
     * BACK-COMPATIBILITY. The still image URL, repeated, because
     * `components/map/registry/cameras.ts` reads this key. Prefer `stillUrl`; this field is
     * the same value and is here only so the shape change and the player land independently.
     */
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
    /**
     * True **only** when `streamUrl` is set. The one flag a player should read before it
     * writes the word "live" anywhere near a timestamp.
     */
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
  // A camera with nothing to show is not a camera we can put on this layer. It is not
  // dropped silently either — the provider's own `records` decides what to emit, and the
  // healthcheck reports the per-provider count an operator can compare with the catalogue.
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
    /**
     * The operator published this coordinate. It is not geocoded from a road name by us, so
     * caveating it would be caveating everything, which is the same as caveating nothing.
     * A provider whose positions are derived rather than published must set this itself.
     */
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

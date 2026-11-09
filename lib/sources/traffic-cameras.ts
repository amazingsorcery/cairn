import { z } from "zod";

import { applyLimit, coordinatePair, describeFailure, parseWith, withinBbox } from "./adapter";
import {
  CAMERA_PROVIDERS,
  findCameraProvider,
  isoDate,
  toCameraFeature,
  type CameraFeature,
  type CameraProvider,
  type CameraRecord,
} from "./cameras";
import { decodeJson, fetchUpstream, lastGoodAt, lastUpstreamStatus, recordGood, recordUpstreamStatus } from "./http";
import { logger } from "@/lib/logger";
import type {
  SourceAdapter,
  SourceContext,
  SourceFailure,
  SourceQuery,
  SourceResult,
} from "./types";

import fintraffic from "@/content/cameras/fintraffic-digitraffic.json";
import linkOnly from "@/content/cameras/link-only-providers.json";
import tfl from "@/content/cameras/transport-for-london.json";

/**
 * Traffic and road cameras from the operators' live catalogues.
 *
 * Only the catalogue (which cameras exist, where) is fetched. Media URLs go to the client,
 * which loads them from the operator on an explicit click; we never proxy media.
 * `content/cameras/` still holds link-only operators and hand-noted cameras.
 *
 * One adapter over several providers (see `cameras/provider.ts`). Each provider has its own
 * cooldown slug and schema; a failing provider is dropped from the poll and logged, and the
 * layer only fails when every provider does.
 *
 * No cap of our own: every published camera is returned, including unavailable ones.
 * `query.limit` is still honoured.
 */

/* ------------------------------------------------------------------ *
 * The committed registry — link-only operators and hand-noted cameras
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

/** One provider's live catalogue. `payload` is validated by `provider.read`, not here. */
const providerEnvelopeSchema = z.object({
  cameraProvider: z.string(),
  payload: z.unknown(),
});

/** Payload: provider results, each a live envelope or a committed registry file. */
export const cameraRegistrySchema = z.array(
  z.union([providerEnvelopeSchema, providerFileSchema]),
);

type ProviderFile = z.infer<typeof providerFileSchema>;

/**
 * Operators without confirmed embed permission or a stable feed; excluded from this layer
 * (their cameras also carry `embedPermitted: false`). Exported for tests.
 */
export const LINK_ONLY_REGISTRY: unknown = linkOnly;

/**
 * Committed camera files. TfL and Fintraffic entries are skipped when their live provider is
 * registered (they'd duplicate it), but the files still seed the registry, admin page and
 * directory.
 */
const CURATED_FILES: readonly unknown[] = [tfl, fintraffic];

/** Provider slugs in `content/cameras/` that a live provider now supersedes. */
const SUPERSEDED_BY_LIVE: Readonly<Record<string, string>> = {
  "transport-for-london": "tfl-jamcams",
  "fintraffic-digitraffic": "fintraffic-weathercams",
};

function isSuperseded(providerSlug: string): boolean {
  const liveSlug = SUPERSEDED_BY_LIVE[providerSlug];
  return liveSlug !== undefined && findCameraProvider(liveSlug) !== undefined;
}

/** Map a committed registry file. Drops anything we have not confirmed we may embed. */
function mapProviderFile(file: ProviderFile): readonly CameraFeature[] {
  const features: CameraFeature[] = [];
  for (const camera of file.cameras) {
    // Never embed a camera without permission, whatever file it's in.
    if (!camera.embedPermitted || !camera.embedUrl) continue;

    const position = coordinatePair(camera.longitude, camera.latitude);
    if (!position) continue;

    features.push({
      id: camera.slug,
      kind: "cameras",
      longitude: position.longitude,
      latitude: position.latitude,
      label: camera.name,
      sourceUrl: camera.sourceUrl,
      precision: null,
      properties: {
        operator: camera.operator,
        providerName: file.provider.name,
        providerSlug: file.provider.slug,
        jurisdiction: camera.jurisdiction,
        locationLabel: camera.locationLabel,
        subject: camera.subject,
        licence: camera.licence,
        attribution: camera.attribution ?? file.provider.attribution,
        attributionRequired: camera.attributionRequired,
        confidence: camera.confidence,
        lastVerifiedAt: camera.lastVerifiedAt,
        /* No live flag in the file; a hand-written entry asserts the URL resolved. */
        available: true,

        embedUrl: camera.embedUrl,
        stillUrl: camera.embedUrl,
        /* The registry schema carries no cadence, so none is claimed. */
        stillRefreshSeconds: null,
        videoUrl: null,
        videoFormat: null,
        videoRefreshSeconds: null,
        streamUrl: null,
        streamFormat: null,
        mediaForms: "still",
        hasLiveStream: false,
      },
    });
  }
  return features;
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

export type { CameraFeature };

/** Records to features, for one provider, stamped with the date they were read. */
function featuresFor(
  provider: CameraProvider,
  records: readonly CameraRecord[],
  observedAt: Date,
): readonly CameraFeature[] {
  const features: CameraFeature[] = [];
  for (const record of records) {
    const feature = toCameraFeature(provider, record, {
      // Read from the operator's API on this poll, so it's verified as of today.
      lastVerifiedAt: isoDate(observedAt),
      confidence: "verified",
    });
    if (feature) features.push(feature);
  }
  return features;
}

/**
 * Validate and map a payload; `[]` if it doesn't fit. For tests with captured fixtures;
 * `fetch` reports bad payloads as `schemaChanged` itself.
 */
export function normaliseCameras(payload: unknown, query: SourceQuery): readonly CameraFeature[] {
  const parsed = cameraRegistrySchema.safeParse(payload);
  if (!parsed.success) return [];

  const receivedAt = new Date();
  const features: CameraFeature[] = [];

  for (const entry of parsed.data) {
    if ("cameraProvider" in entry) {
      const provider = findCameraProvider(entry.cameraProvider);
      if (!provider) continue;
      const read = provider.read(entry.payload, receivedAt);
      // A provider's shape change drops only its own cameras.
      if (!read.ok) continue;
      features.push(...featuresFor(provider, read.records, read.observedAt));
      continue;
    }
    features.push(...mapProviderFile(entry));
  }

  return applyLimit(
    features.filter((feature) => withinBbox(feature, query)),
    query,
  );
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export const TRAFFIC_CAMERAS_SLUG = "traffic-cameras";

/** Per-provider cooldown slug, so one operator's 429 doesn't silence the others. */
function providerSlug(provider: CameraProvider): string {
  return `${TRAFFIC_CAMERAS_SLUG}:${provider.slug}`;
}

interface ProviderOutcome {
  readonly provider: CameraProvider;
  readonly result:
    | { readonly ok: true; readonly features: readonly CameraFeature[]; readonly observedAt: Date }
    | { readonly ok: false; readonly failure: SourceFailure };
}

/** Fetch, decode, validate and map one provider. Never throws for an expected condition. */
async function pollProvider(
  provider: CameraProvider,
  ctx: SourceContext,
): Promise<ProviderOutcome> {
  const slug = providerSlug(provider);

  const outcome = await fetchUpstream({
    slug,
    url: provider.catalogueUrl,
    signal: ctx.signal,
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
    ...(provider.maxBytes === undefined ? {} : { maxBytes: provider.maxBytes }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
  });
  if (!outcome.ok) return { provider, result: { ok: false, failure: outcome.failure } };

  const decoded = decodeJson(outcome.text);
  if (!decoded.ok) return { provider, result: { ok: false, failure: decoded.failure } };

  const read = provider.read(decoded.body, new Date());
  if (!read.ok) return { provider, result: { ok: false, failure: read.failure } };

  const features = featuresFor(provider, read.records, read.observedAt);
  recordGood(slug, read.observedAt);
  return { provider, result: { ok: true, features, observedAt: read.observedAt } };
}

/**
 * The failure to report when every provider failed. One is passed through; several become an
 * `upstreamError` naming each (our message, never an upstream body).
 */
function aggregateFailure(outcomes: readonly ProviderOutcome[]): SourceFailure {
  const failures = outcomes.flatMap((outcome) =>
    outcome.result.ok ? [] : [{ slug: outcome.provider.slug, failure: outcome.result.failure }],
  );

  if (failures.length === 0) {
    return { kind: "disabled", reason: "no camera providers are configured" };
  }
  const first = failures[0];
  if (!first) return { kind: "disabled", reason: "no camera providers are configured" };
  if (failures.length === 1) return first.failure;

  // All rate-limited: keep that kind rather than a generic error.
  if (failures.every((entry) => entry.failure.kind === "rateLimited")) {
    const longest = Math.max(
      ...failures.map((entry) =>
        entry.failure.kind === "rateLimited" ? (entry.failure.retryAfterSeconds ?? 0) : 0,
      ),
    );
    return longest > 0
      ? { kind: "rateLimited", retryAfterSeconds: longest }
      : { kind: "rateLimited" };
  }

  return {
    kind: "upstreamError",
    message: failures
      .map((entry) => `${entry.slug}: ${describeFailure(entry.failure)}`)
      .join("; "),
  };
}

/** Oldest successful observation: a mixed payload is only as fresh as its stalest part. */
function oldestObservation(outcomes: readonly ProviderOutcome[], fallback: Date): Date {
  let oldest: number | null = null;
  for (const outcome of outcomes) {
    if (!outcome.result.ok) continue;
    const at = outcome.result.observedAt.getTime();
    oldest = oldest === null ? at : Math.min(oldest, at);
  }
  return oldest === null ? fallback : new Date(oldest);
}

/** The committed registry files this poll should still contribute. */
function curatedFeatures(): readonly CameraFeature[] {
  const parsed = parseWith(z.array(providerFileSchema), CURATED_FILES);
  if (!parsed.ok) {
    // A committed-file mistake, but degrade rather than throw.
    logger.error(
      { scope: "source.cameras", slug: TRAFFIC_CAMERAS_SLUG, reason: "registryShape" },
      "content/cameras/*.json no longer matches its schema; curated cameras dropped",
    );
    return [];
  }
  return parsed.data.filter((file) => !isSuperseded(file.provider.slug)).flatMap(mapProviderFile);
}

export const trafficCameras: SourceAdapter<CameraFeature> = {
  slug: TRAFFIC_CAMERAS_SLUG,
  name: "Traffic and road cameras",
  kind: "cameras",
  homepage: "https://www.digitraffic.fi/en/",
  attribution: {
    // Layer-level summary. Licences are satisfied by each feature's own `attribution`.
    text: "Camera data: Transport for London (Powered by TfL Open Data) and Fintraffic / digitraffic.fi (CC BY 4.0)",
    href: "https://www.digitraffic.fi/en/terms-of-service/",
    licence: "TfL open data terms; CC BY 4.0 (per camera — see each feature)",
  },
  /**
   * Six hours: the catalogue changes over weeks. Imagery isn't fetched by us; each feature
   * carries the operator's refresh interval.
   */
  ttlSeconds: 21_600,
  /** Two days: a camera index stays largely true through an upstream outage. */
  staleWhileRevalidateSeconds: 172_800,
  responseSchema: cameraRegistrySchema,
  normalise: normaliseCameras,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<CameraFeature>> {
    // In parallel, so one slow operator doesn't eat the budget.
    const outcomes = await Promise.all(
      CAMERA_PROVIDERS.map((provider) => pollProvider(provider, ctx)),
    );

    // Mirror per-provider statuses onto the adapter slug, which the audit row reads.
    for (const outcome of outcomes) {
      const status = lastUpstreamStatus(providerSlug(outcome.provider));
      if (status !== null) recordUpstreamStatus(TRAFFIC_CAMERAS_SLUG, status);
    }

    for (const outcome of outcomes) {
      if (outcome.result.ok) continue;
      // Partial failures render as success, so log which provider failed.
      logger.error(
        {
          scope: "source.cameras",
          slug: TRAFFIC_CAMERAS_SLUG,
          provider: outcome.provider.slug,
          failure: outcome.result.failure.kind,
          detail: describeFailure(outcome.result.failure),
        },
        "Camera provider unavailable; its cameras are absent from this poll",
      );
    }

    const live = outcomes.flatMap((outcome) => (outcome.result.ok ? outcome.result.features : []));
    const curated = curatedFeatures();
    const features = [...live, ...curated];

    const everyProviderFailed = outcomes.every((outcome) => !outcome.result.ok);
    if (everyProviderFailed && curated.length === 0) {
      return {
        ok: false,
        failure: aggregateFailure(outcomes),
        lastGoodAt: lastGoodAt(TRAFFIC_CAMERAS_SLUG),
      };
    }

    const observedAt = oldestObservation(outcomes, new Date());
    recordGood(TRAFFIC_CAMERAS_SLUG, observedAt);

    return {
      ok: true,
      features: applyLimit(
        features.filter((feature) => withinBbox(feature, query)),
        query,
      ),
      observedAt,
    };
  },

  /** Reports per provider, so one failing operator isn't hidden by a healthy total. */
  async healthcheck(ctx: SourceContext) {
    const outcomes = await Promise.all(
      CAMERA_PROVIDERS.map((provider) => pollProvider(provider, ctx)),
    );
    const parts = outcomes.map((outcome) =>
      outcome.result.ok
        ? `${outcome.provider.slug}: ${outcome.result.features.length} cameras`
        : `${outcome.provider.slug}: ${describeFailure(outcome.result.failure)}`,
    );
    const curated = curatedFeatures();
    if (curated.length > 0) parts.push(`content/cameras: ${curated.length} cameras`);

    return {
      ok: outcomes.some((outcome) => outcome.result.ok),
      detail: parts.join("; "),
    };
  },
};

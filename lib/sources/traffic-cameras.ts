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
 * Traffic and road cameras — the operators' **live catalogues**, in full.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, AND WHY IT WAS A BUG RATHER THAN A DESIGN
 * ─────────────────────────────────────────────────────────────────────────────
 * This adapter used to serve `content/cameras/*.json` and make no request at all. That was
 * right about the *imagery* — we never fetch a frame, and that has not changed — and wrong
 * about the *catalogue*. Ten hand-copied cameras were being served from two operators who
 * publish 890 and 2,279 of them respectively, under licences this repository had already
 * read, recorded and dated. Serving ten of those is not a conservative reading of a licence;
 * it is a stale copy of a list that is published as an API.
 *
 * So the catalogue is fetched. `content/cameras/` keeps the job it is genuinely good at:
 * link-only operators, and cameras that need a hand-written note. A camera that comes from a
 * live catalogue does not need a JSON row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS STILL TRUE, AND IS THE RULE THE WHOLE BUILD HANGS OFF
 * ─────────────────────────────────────────────────────────────────────────────
 * **We never proxy media.** This adapter fetches small JSON saying which cameras exist and
 * where. Every still, video and stream URL is handed to the client, and the reader's browser
 * connects to the operator directly on an explicit press (ADR 0015 — click-to-load).
 * Relaying video through this deployment is roughly 1000x its entire bandwidth budget
 * (docs/deploy/RUNBOOK.md §21), and it turns a linking site into a rebroadcasting one, which
 * is a different legal posture entirely (product-brief §2b).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE ADAPTER, SEVERAL OPERATORS, AND WHAT THAT COSTS
 * ─────────────────────────────────────────────────────────────────────────────
 * See `cameras/provider.ts` for the argument. In short: the map has one cameras layer, so
 * one operator per `SourceAdapter` would mean one layer per operator in
 * `components/map/registry/`, which is the "adding a source must never require touching the
 * map component" rule failing from the other side.
 *
 * The consequence that matters is **degradation granularity**, and it is handled explicitly:
 * each provider is fetched under its own cooldown slug, parsed against its own schema, and a
 * provider that fails is dropped from this poll while every other provider still renders.
 * The failure is logged with the provider slug, and `healthcheck()` reports per provider, so
 * an operator can see which upstream changed shape. The layer only reports a failure when
 * **every** provider failed and nothing is left to draw.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO CAP. NOT ONE WE CHOSE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every camera each provider publishes is returned, including the ones the operator itself
 * marks unavailable (`properties.available: false`). `query.limit` is honoured because it is
 * the *caller* asking for fewer, but this adapter imposes no ceiling of its own — a count
 * that quietly disagrees with the operator's catalogue, with nothing on screen to say so, is
 * the failure this build has hit repeatedly.
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

/**
 * One provider's live catalogue, tagged with the provider it came from.
 *
 * `payload` is deliberately unvalidated here: the provider owns its own schema, and
 * validating it twice would mean two places that have to agree about a shape neither of them
 * controls. `normalise` hands it to `provider.read`, which is where the decision is made.
 */
const providerEnvelopeSchema = z.object({
  cameraProvider: z.string(),
  payload: z.unknown(),
});

/**
 * The adapter's payload: a list of provider results, each either a **live envelope** or a
 * **committed registry file**.
 *
 * A union rather than one shape, because the layer genuinely mixes the two and always will:
 * an operator with a documented API contributes an envelope, an operator that publishes only
 * a web page contributes a hand-written registry file. Both end up as the same feature.
 */
export const cameraRegistrySchema = z.array(
  z.union([providerEnvelopeSchema, providerFileSchema]),
);

type ProviderFile = z.infer<typeof providerFileSchema>;

/**
 * Exported so a test can assert the exclusion is real rather than incidental.
 *
 * `link-only-providers.json` holds operators that are unambiguously publishing, but where an
 * embed permission or a stable feed URL could not be confirmed. They are excluded from this
 * layer *because* of that, and every camera in the file additionally carries
 * `embedPermitted: false`, which `mapProviderFile` drops on its own.
 */
export const LINK_ONLY_REGISTRY: unknown = linkOnly;

/**
 * The committed files, minus any operator now served live.
 *
 * `transport-for-london.json` and `fintraffic-digitraffic.json` remain in `content/cameras/`
 * and are still the seed for the operator registry, the admin page and the directory — but
 * their ten cameras are a hand-copied subset of catalogues this adapter now fetches whole, so
 * including them here would put ten duplicate dots on the map. The claim is by provider
 * slug, in one place, rather than by a list of camera slugs that would rot.
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
    // A camera we may not embed has no business on an embedding layer, whatever file it
    // arrived in. Belt and braces over the registry split.
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
        /*
         * A hand-written entry records that a human confirmed the URL resolves. Nothing in
         * the file carries a live availability flag, and inventing `false` would be as wrong
         * as inventing `true`; `true` is what the entry asserts by existing.
         */
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
      /*
       * The date this record was read from the operator's own API — which is what
       * `lastVerifiedAt` has always meant here, and is now a fact about today rather than
       * about the day somebody hand-copied a list. `verified` on product-brief §6's scale is
       * "checked against the primary source during this build", and this is that check
       * happening on every poll.
       */
      lastVerifiedAt: isoDate(observedAt),
      confidence: "verified",
    });
    if (feature) features.push(feature);
  }
  return features;
}

/**
 * Validate a payload and map it. Returns `[]` when it does not fit.
 *
 * The empty array is not a claim that there are no cameras: `fetch` has already decided and
 * returned `schemaChanged` before anything reaches here on a real bad payload. This entry
 * point exists so a test can hand a captured fixture straight in.
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
      // One provider's shape change removes one provider's cameras, and nothing else.
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

/**
 * The cooldown and last-good slug for one provider.
 *
 * Per provider, not per adapter. `fetchUpstream` opens a cooldown on a 429 and refuses every
 * later call under that slug until it expires — correct behaviour, and a disaster if shared:
 * one operator refusing us would silence every camera network on the map, which is the exact
 * "one bad upstream must never break the layer" failure the whole contract exists to prevent.
 */
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
 * One failure to report when **every** provider failed.
 *
 * A single failure is passed through unchanged, because its kind is what an operator acts on.
 * Several are collapsed into an `upstreamError` naming each provider and what it did — the
 * message is ours, never an upstream body — because a layer cannot render two failure states
 * and reporting only the first would hide the rest.
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

  // All refused us: the fix is to back off, and that is worth keeping as its own kind rather
  // than flattening into a generic error an operator would go looking for an outage behind.
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

/**
 * The oldest successful observation.
 *
 * A mixed payload is only as fresh as its stalest part, and `observedAt` drives the age a
 * reader is shown. Taking the newest would let a provider that answered a second ago vouch
 * for one whose catalogue is a day old.
 */
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
    // A build-time mistake rather than an upstream one — the files are committed — but it
    // still degrades to "no curated cameras" instead of throwing into the poll.
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
    /**
     * The layer-level credit names the operators, because this layer mixes providers under
     * different licences. The PER-CAMERA attribution in `properties.attribution` is the one
     * that satisfies each licence at the point of display — TfL's terms require their exact
     * wording including the Ordnance Survey notice, and CC BY requires Fintraffic's. A single
     * blended string would satisfy neither.
     */
    text: "Camera data: Transport for London (Powered by TfL Open Data) and Fintraffic / digitraffic.fi (CC BY 4.0)",
    href: "https://www.digitraffic.fi/en/terms-of-service/",
    licence: "TfL open data terms; CC BY 4.0 (per camera — see each feature)",
  },
  /**
   * SIX HOURS, against product-brief §2b's "webcam metadata ~1h".
   *
   * Deliberately more conservative than the brief, not less. What is fetched is a *catalogue*
   * — which cameras exist and where — and a road authority adds or moves a camera on the
   * scale of weeks. Digitraffic's own instructions say "there is no gain calling the services
   * too often"; TfL's terms cap us at 500 calls per minute per feed and we make four a day.
   * The imagery, which is the part that changes every few minutes, is never fetched by us at
   * all: the reader's browser loads it at view time and each feature carries the operator's
   * own refresh interval so the UI can say how old a frame is.
   */
  ttlSeconds: 21_600,
  /**
   * Two days. A camera index is still substantially true after a day of an upstream being
   * unreachable, which is exactly the case stale-while-revalidate exists for. Aircraft
   * declare three minutes for the opposite reason.
   */
  staleWhileRevalidateSeconds: 172_800,
  responseSchema: cameraRegistrySchema,
  normalise: normaliseCameras,

  async fetch(query: SourceQuery, ctx: SourceContext): Promise<SourceResult<CameraFeature>> {
    /*
     * In parallel, so one slow operator does not spend the whole request budget and so a
     * cooldown opened by the first cannot pre-empt the second inside a single poll.
     */
    const outcomes = await Promise.all(
      CAMERA_PROVIDERS.map((provider) => pollProvider(provider, ctx)),
    );

    /*
     * The audit row is written per adapter, and `governed.ts` reads the status off the
     * adapter slug. We fetched under per-provider slugs, so the last provider status is
     * mirrored across — otherwise the one column that distinguishes a 429 from a 502 is null
     * on every camera poll.
     */
    for (const outcome of outcomes) {
      const status = lastUpstreamStatus(providerSlug(outcome.provider));
      if (status !== null) recordUpstreamStatus(TRAFFIC_CAMERAS_SLUG, status);
    }

    for (const outcome of outcomes) {
      if (outcome.result.ok) continue;
      /*
       * Logged with the provider slug, because "which upstream changed shape" is the single
       * thing an operator needs and the map has nowhere to put it: the layer renders one
       * status, and a partial failure still renders as a success with fewer dots.
       */
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

  /**
   * Per provider, in one sentence each.
   *
   * A layer-level "3,169 cameras" hides the case this adapter is most likely to meet: one
   * operator of several has changed shape or gone down, the map still looks healthy, and the
   * only visible symptom is a country's worth of missing dots.
   */
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

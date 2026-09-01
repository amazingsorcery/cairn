import type { ConnectorKind } from "@/db/schema";

import { SOURCE_ADAPTERS } from "./index";

/**
 * Registry rows for every wired source.
 *
 * `pollSource` refuses any adapter with no `connectors` row — there is no recorded basis to
 * call it — which is the governed path behaving exactly as product-brief §3.3 requires. The
 * consequence is that a source without a row here is a DEAD LAYER on a fresh database, and
 * that is how `/map` came to ship with earthquakes and weather permanently unavailable.
 *
 * Operational fields (TTL, stale window, attribution, homepage) are read from the adapter
 * rather than restated, so the row and the code cannot disagree. They already did once:
 * adsb.lol carried 60s on the row against 30s in the adapter.
 *
 * What lives here is only what an adapter has no business knowing — who operates the source,
 * where its terms are, and the recorded basis on which we call it. Those come from
 * `docs/sources/<slug>.md`, where a human actually read them.
 *
 * Everything seeds `enabled: false, status: draft` — fail closed, ADR 0012 §1. An operator
 * reads the basis and turns each one on deliberately. A layer saying an operator switched it
 * off is honest; one that starts calling an upstream nobody reviewed is not.
 */

interface TermsRecord {
  readonly operatorName: string;
  readonly termsUrl: string;
  readonly legalBasis: string;
  readonly baseUrl: string;
  readonly globalCeiling: number;
  readonly perUserQuota: number;
  /**
   * Overrides the adapter's `ttlSeconds` when an operator decision differs from the code
   * default. The row is the authority at runtime, so seeding the adapter constant over a
   * deliberately more conservative row would silently double a poll rate — which is exactly
   * what happened to adsb.lol the first time this file was written.
   */
  readonly cacheTtlSeconds?: number;
  readonly notes: string;
}

/** One entry per adapter in `SOURCE_ADAPTERS`. A missing entry is fatal, deliberately. */
const TERMS: Readonly<Record<string, TermsRecord>> = {
  "usgs-earthquakes": {
    operatorName: "United States Geological Survey",
    termsUrl: "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
    legalBasis:
      "US Government work, public domain. Published for reuse; credit asked for rather than " +
      "licensed. No key, no registration. The 60s TTL is read off their own " +
      "Cache-Control: max-age=60 — their number, not our guess.",
    baseUrl: "https://earthquake.usgs.gov",
    globalCeiling: 60,
    perUserQuota: 30,
    notes: "Verified 2026-08-31. See docs/sources/usgs-earthquakes.md.",
  },
  "nws-alerts": {
    operatorName: "NOAA / National Weather Service",
    termsUrl: "https://www.weather.gov/documentation/services-web-api",
    legalBasis:
      "US Government work, public domain. NWS publishes no numeric limit but states it allows " +
      "a generous amount and warns that proxies are more likely to reach it — and by their " +
      "definition we are a proxy, so this ceiling is deliberately conservative. They ask for " +
      "a contact address in the User-Agent; SOURCE_CONTACT_EMAIL supplies it.",
    baseUrl: "https://api.weather.gov",
    globalCeiling: 30,
    perUserQuota: 15,
    notes:
      "Only about 1.3 percent of active alerts carry inline geometry; the rest are zone codes " +
      "resolved to a point and marked with locationBasis. See docs/sources/nws-alerts.md.",
  },
  "radio-browser": {
    operatorName: "Radio Browser (community maintained)",
    termsUrl: "https://api.radio-browser.info/",
    legalBasis:
      "Public domain dedication. Stream URLs are handed to the client, which connects to the " +
      "broadcaster directly — we never relay audio (product-brief §2b). About 20 percent of " +
      "stations publish plain http and cannot play on an HTTPS page; those are flagged, not " +
      "hidden.",
    baseUrl: "https://all.api.radio-browser.info",
    globalCeiling: 10,
    perUserQuota: 5,
    notes: "Verified 2026-08-31. See docs/sources/radio-browser.md.",
  },
  "traffic-cameras": {
    operatorName: "Transport for London; Fintraffic",
    termsUrl: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
    legalBasis:
      "ONE ROW, TWO OPERATORS, AND EACH HAS ITS OWN RECORD. TfL transport data service terms " +
      "grant a worldwide, royalty-free, perpetual licence to publish and adapt, subject to " +
      "mandatory attribution, and additionally forbid cropping or re-branding the images " +
      "(docs/sources/tfl-jamcams.md). Fintraffic Digitraffic is CC BY 4.0 and makes gzip a " +
      "condition of use (docs/sources/fintraffic-weathercams.md). What is fetched is the " +
      "CATALOGUE — which cameras exist and where — never a frame or a clip: imagery loads in " +
      "the reader's browser on an explicit click and is never proxied or re-hosted (ADR 0015, " +
      "product-brief §2b).",
    baseUrl: "https://api.tfl.gov.uk",
    /*
     * The ceiling counts POLLS; one poll makes one request per provider, so this is 10 polls
     * and 20 upstream requests per minute with the two providers wired today. That sits under
     * Digitraffic's published 60/min per IP and far under TfL's 500/min per feed. **It has to
     * be revisited every time a provider is added**, because the request count per poll grows
     * with the registry while this number does not.
     */
    globalCeiling: 10,
    perUserQuota: 5,
    notes:
      "Terms re-read 2026-09-01 and the catalogues are now fetched live: 890 TfL JamCams and " +
      "2,279 Fintraffic weathercam presets on that date, against the 10 hand-copied cameras " +
      "this layer used to serve. See docs/sources/traffic-cameras.md.",
  },
  "nasa-firms": {
    operatorName: "NASA FIRMS / LANCE",
    termsUrl: "https://firms.modaps.eosdis.nasa.gov/usfs/api/",
    legalBasis:
      "NASA open data, free to use with attribution. The only source here publishing a numeric " +
      "limit: 5000 transactions per 10-minute interval. Requires FIRMS_MAP_KEY; without it the " +
      "layer reports notConfigured rather than failing.",
    baseUrl: "https://firms.modaps.eosdis.nasa.gov",
    globalCeiling: 20,
    perUserQuota: 10,
    notes:
      "SCHEMA UNVERIFIED — a key is needed to capture a real payload and none was available " +
      "during the build. See docs/sources/nasa-firms.md.",
  },
  "seattle-fire-911": {
    operatorName: "City of Seattle / Seattle Fire Department (data.seattle.gov, Socrata)",
    termsUrl: "https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj",
    legalBasis:
      "Public Domain, declared in the dataset metadata (license.name = \"Public Domain\", " +
      "attribution \"City of Seattle\"). No key gate. Refresh frequency published on the " +
      "dataset as \"Near Realtime\". Socrata throttles per IP without an app token and does " +
      "not throttle reasonable use with one (SOCRATA_APP_TOKEN, optional). LIVE-ONLY per " +
      "ADR 0033: features are displayed, never persisted, and medical dispatch carries " +
      "isMedical so the UI defaults it OFF. See docs/sources/seattle-fire-911.md.",
    baseUrl: "https://data.seattle.gov",
    globalCeiling: 60,
    perUserQuota: 30,
    notes:
      "Verified 2026-09-01: a live fetch returned dispatches timestamped minutes earlier; " +
      "\"Aid Response\" and \"Medic Response\" are the two largest call types and are marked " +
      "medical. See docs/sources/seattle-fire-911.md.",
  },
  "sf-police-911": {
    operatorName: "City & County of San Francisco / SFPD (data.sfgov.org, Socrata)",
    termsUrl:
      "https://data.sfgov.org/Public-Safety/Law-Enforcement-Dispatched-Calls-for-Service-Real-T/gnap-fj3t",
    legalBasis:
      "ODC Public Domain Dedication and License (PDDL) 1.0, declared in the dataset " +
      "metadata. No key gate. Publishing frequency \"Multiple times per hour\". SFPD sets " +
      "sensitive_call=true and withholds those locations; the adapter drops every " +
      "sensitive_call row and reconstructs nothing (ADR 0033, no identity resolution). " +
      "LIVE-ONLY: displayed, never persisted; medical/behavioural-health calls carry " +
      "isMedical and default OFF. SF's fire dataset publishes daily and is rejected for the " +
      "live layer. See docs/sources/sf-police-911.md.",
    baseUrl: "https://data.sfgov.org",
    globalCeiling: 30,
    perUserQuota: 15,
    notes:
      "Verified 2026-09-01: live rows timestamped minutes earlier; 52 of 150 rows were " +
      "sensitive_call and location-withheld, and are dropped. See docs/sources/sf-police-911.md.",
  },
  "adsb-lol": {
    operatorName: "adsb.lol (community ADS-B aggregator)",
    termsUrl: "https://api.adsb.lol/docs",
    legalBasis:
      "ODbL 1.0, declared in their OpenAPI document. They publish no rate limit and send no " +
      "Retry-After; measurement found refusals from around 10 requests per minute, so THEIR " +
      "limiter is the authority and these columns are a conservative envelope inside it. " +
      "See ADR 0021.",
    baseUrl: "https://api.adsb.lol",
    globalCeiling: 6,
    perUserQuota: 3,
    // 60s, not the adapter's 30s. Deliberately more conservative: one poll per minute per
    // viewport instead of two, further inside a ceiling that measurement put around 10/min.
    // ADR 0021 has the arithmetic and why three concurrent viewports is the real limit.
    cacheTtlSeconds: 60,
    notes: "Verified 2026-08-31. See docs/sources/adsb-lol.md and ADR 0021.",
  },
};

export interface ConnectorSeed {
  readonly slug: string;
  readonly name: string;
  /**
   * Narrowed to `ConnectorKind`, not `string`. Sources and connectors are one registry
   * (ADR 0024), so every `SourceKind` is a member — but typing it loosely would let a typo
   * reach a CHECK constraint and surface as a 23514 at seed time instead of here.
   */
  readonly kind: ConnectorKind;
  readonly operatorName: string;
  readonly homepageUrl: string;
  readonly termsUrl: string;
  readonly attribution: string;
  readonly attributionRequired: boolean;
  readonly legalBasis: string;
  readonly baseUrl: string;
  readonly requiresApiKey: boolean;
  readonly apiKeyEnvVar: string | null;
  readonly perUserQuota: number;
  readonly globalCeiling: number;
  readonly windowSeconds: number;
  readonly timeoutMs: number;
  readonly cacheTtlSeconds: number;
  readonly staleWhileRevalidateSeconds: number;
  readonly enabled: boolean;
  readonly status: "draft";
  readonly notes: string;
}

/** Built from the adapters, so a row cannot drift from the code that uses it. */
export const SOURCE_CONNECTOR_SEEDS: readonly ConnectorSeed[] = SOURCE_ADAPTERS.map((adapter) => {
  const terms = TERMS[adapter.slug];
  if (!terms) {
    // Deliberately fatal. A wired adapter with no recorded terms would seed no row, and the
    // layer would be permanently unavailable with no obvious cause — exactly the failure
    // this file exists to end. Better to stop the seed than to ship a dead layer quietly.
    throw new Error(
      `No terms record for source "${adapter.slug}". Add one to lib/sources/connector-seeds.ts ` +
        `using the licence and rate limit recorded in docs/sources/${adapter.slug}.md, or the ` +
        `layer will be dead on every fresh database.`,
    );
  }

  return {
    slug: adapter.slug,
    name: adapter.name,
    kind: adapter.kind,
    operatorName: terms.operatorName,
    homepageUrl: adapter.homepage,
    termsUrl: terms.termsUrl,
    attribution: adapter.attribution.text,
    attributionRequired: true,
    legalBasis: terms.legalBasis,
    baseUrl: terms.baseUrl,
    requiresApiKey: adapter.apiKeyEnvVar !== undefined,
    apiKeyEnvVar: adapter.apiKeyEnvVar ?? null,
    perUserQuota: terms.perUserQuota,
    globalCeiling: terms.globalCeiling,
    windowSeconds: 60,
    timeoutMs: 8000,
    cacheTtlSeconds: terms.cacheTtlSeconds ?? adapter.ttlSeconds,
    staleWhileRevalidateSeconds: adapter.staleWhileRevalidateSeconds,
    enabled: false,
    status: "draft",
    notes: terms.notes,
  };
});

import type { ConnectorKind } from "@/db/schema";

import { SOURCE_ADAPTERS } from "./index";

/**
 * Registry rows for every wired source. `pollSource` refuses adapters without a row, so a
 * missing entry here means a dead layer on a fresh database.
 *
 * Operational fields (TTL, stale window, attribution, homepage) come from the adapter so they
 * can't disagree. This file holds only operator, terms URL and legal basis.
 *
 * All seed disabled/draft (fail closed); an operator enables each after review.
 */

interface TermsRecord {
  readonly operatorName: string;
  readonly termsUrl: string;
  readonly legalBasis: string;
  readonly baseUrl: string;
  readonly globalCeiling: number;
  readonly perUserQuota: number;
  /** Overrides the adapter's `ttlSeconds` when the row should be more conservative. */
  readonly cacheTtlSeconds?: number;
  readonly notes: string;
}

/** One entry per adapter in `SOURCE_ADAPTERS`. A missing entry is fatal. */
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
    notes: "Verified 2026-08-31.",
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
      "resolved to a point and marked with locationBasis.",
  },
  "radio-browser": {
    operatorName: "Radio Browser (community maintained)",
    termsUrl: "https://api.radio-browser.info/",
    legalBasis:
      "Public domain dedication. Stream URLs are handed to the client, which connects to the " +
      "broadcaster directly — we never relay audio. About 20 percent of " +
      "stations publish plain http and cannot play on an HTTPS page; those are flagged, not " +
      "hidden.",
    baseUrl: "https://all.api.radio-browser.info",
    globalCeiling: 10,
    perUserQuota: 5,
    notes: "Verified 2026-08-31.",
  },
  "traffic-cameras": {
    operatorName: "Transport for London; Fintraffic",
    termsUrl: "https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service",
    legalBasis:
      "ONE ROW, TWO OPERATORS, AND EACH HAS ITS OWN RECORD. TfL transport data service terms " +
      "grant a worldwide, royalty-free, perpetual licence to publish and adapt, subject to " +
      "mandatory attribution, and additionally forbid cropping or re-branding the images. " +
      "Fintraffic Digitraffic is CC BY 4.0 and makes gzip a " +
      "condition of use. What is fetched is the " +
      "CATALOGUE — which cameras exist and where — never a frame or a clip: imagery loads in " +
      "the reader's browser on an explicit click and is never proxied or re-hosted.",
    baseUrl: "https://api.tfl.gov.uk",
    /*
     * Counts polls; each poll makes one request per provider (20/min with two providers,
     * under Digitraffic's 60/min). Revisit when adding a provider.
     */
    globalCeiling: 10,
    perUserQuota: 5,
    notes:
      "Terms re-read 2026-09-01 and the catalogues are now fetched live: 890 TfL JamCams and " +
      "2,279 Fintraffic weathercam presets on that date, against the 10 hand-copied cameras " +
      "this layer used to serve.",
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
      "during the build.",
  },
  "seattle-fire-911": {
    operatorName: "City of Seattle / Seattle Fire Department (data.seattle.gov, Socrata)",
    termsUrl: "https://data.seattle.gov/Public-Safety/Seattle-Real-Time-Fire-911-Calls/kzjm-xkqj",
    legalBasis:
      "Public Domain, declared in the dataset metadata (license.name = \"Public Domain\", " +
      "attribution \"City of Seattle\"). No key gate. Refresh frequency published on the " +
      "dataset as \"Near Realtime\". Socrata throttles per IP without an app token and does " +
      "not throttle reasonable use with one (SOCRATA_APP_TOKEN, optional). LIVE-ONLY: " +
      "features are displayed, never persisted, and medical dispatch carries " +
      "isMedical so the UI defaults it OFF.",
    baseUrl: "https://data.seattle.gov",
    globalCeiling: 60,
    perUserQuota: 30,
    notes:
      "Verified 2026-09-01: a live fetch returned dispatches timestamped minutes earlier; " +
      "\"Aid Response\" and \"Medic Response\" are the two largest call types and are marked " +
      "medical.",
  },
  "sf-police-911": {
    operatorName: "City & County of San Francisco / SFPD (data.sfgov.org, Socrata)",
    termsUrl:
      "https://data.sfgov.org/Public-Safety/Law-Enforcement-Dispatched-Calls-for-Service-Real-T/gnap-fj3t",
    legalBasis:
      "ODC Public Domain Dedication and License (PDDL) 1.0, declared in the dataset " +
      "metadata. No key gate. Publishing frequency \"Multiple times per hour\". SFPD sets " +
      "sensitive_call=true and withholds those locations; the adapter drops every " +
      "sensitive_call row and reconstructs nothing (no identity resolution). " +
      "LIVE-ONLY: displayed, never persisted; medical/behavioural-health calls carry " +
      "isMedical and default OFF. SF's fire dataset publishes daily and is rejected for the " +
      "live layer.",
    baseUrl: "https://data.sfgov.org",
    globalCeiling: 30,
    perUserQuota: 15,
    notes:
      "Verified 2026-09-01: live rows timestamped minutes earlier; 52 of 150 rows were " +
      "sensitive_call and location-withheld, and are dropped.",
  },
  "adsb-lol": {
    operatorName: "adsb.lol (community ADS-B aggregator)",
    termsUrl: "https://api.adsb.lol/docs",
    legalBasis:
      "ODbL 1.0, declared in their OpenAPI document. They publish no rate limit and send no " +
      "Retry-After; measurement found refusals from around 10 requests per minute, so THEIR " +
      "limiter is the authority and these columns are a conservative envelope inside it.",
    baseUrl: "https://api.adsb.lol",
    globalCeiling: 6,
    perUserQuota: 3,
    // 60s, not the adapter's 30s: one poll per minute per viewport, further inside the
    // ~10/min refusal threshold.
    cacheTtlSeconds: 60,
    notes: "Verified 2026-08-31.",
  },
};

export interface ConnectorSeed {
  readonly slug: string;
  readonly name: string;
  /** `ConnectorKind`, not `string`, so a typo fails at compile time rather than as a DB 23514. */
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
    // Fatal: otherwise the layer would silently be dead on a fresh database.
    throw new Error(
      `No terms record for source "${adapter.slug}". Add one to lib/sources/connector-seeds.ts ` +
        `with its licence and rate limit, or the ` +
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

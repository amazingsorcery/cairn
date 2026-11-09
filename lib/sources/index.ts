import { adsbLol } from "./adsb-lol";
import { nasaFirms } from "./nasa-firms";
import { nwsAlerts } from "./nws-alerts";
import { radioBrowser } from "./radio-browser";
import { seattleFire911 } from "./seattle-fire-911";
import { sfPolice911 } from "./sf-police-911";
import { trafficCameras } from "./traffic-cameras";
import { usgsEarthquakes } from "./usgs-earthquakes";
import type { SourceAdapter, SourceFeature, SourceKind } from "./types";

/**
 * The source registry. Adding a source is one file plus one entry here; no map component,
 * route or query changes.
 *
 * Each adapter has its terms in its header comment and a `connectors` row (kill switch,
 * quotas, TTL) in `connector-seeds.ts`. Reach them through `pollSource`, never `adapter.fetch`.
 */
export const SOURCE_ADAPTERS: readonly SourceAdapter<SourceFeature>[] = [
  usgsEarthquakes,
  nwsAlerts,
  adsbLol,
  radioBrowser,
  trafficCameras,
  nasaFirms,
  seattleFire911,
  sfPolice911,
];

/** Look one up by slug. Returns undefined rather than throwing for an unknown layer. */
export function findAdapter(slug: string): SourceAdapter<SourceFeature> | undefined {
  return SOURCE_ADAPTERS.find((adapter) => adapter.slug === slug);
}

/** Every adapter of one kind, for grouping the layer legend. */
export function adaptersOfKind(kind: SourceKind): readonly SourceAdapter<SourceFeature>[] {
  return SOURCE_ADAPTERS.filter((adapter) => adapter.kind === kind);
}

/** Adapters whose key is unset; show as "not configured", not "broken". */
export function unconfiguredAdapters(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly SourceAdapter<SourceFeature>[] {
  return SOURCE_ADAPTERS.filter(
    (adapter) => adapter.apiKeyEnvVar !== undefined && !env[adapter.apiKeyEnvVar]?.trim(),
  );
}

export { createMemoryCache } from "./cache";
export { describeFailure } from "./adapter";

/**
 * Use `pollSource` to reach an upstream. `adapter.fetch`/`healthcheck` skip the kill switch,
 * global ceiling and audit row.
 */
export { pollSource, healthcheckSource, WORKER_ACTOR_SUBJECT } from "./governed";
export type { GovernedPoll, GovernanceDeps } from "./governed";
export type {
  Attribution,
  CachedSourceResult,
  SourceAdapter,
  SourceCache,
  SourceContext,
  SourceFailure,
  SourceFeature,
  SourceKind,
  SourceQuery,
  SourceResult,
} from "./types";

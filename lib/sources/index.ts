import { adsbLol } from "./adsb-lol";
import { nasaFirms } from "./nasa-firms";
import { nwsAlerts } from "./nws-alerts";
import { radioBrowser } from "./radio-browser";
import { trafficCameras } from "./traffic-cameras";
import { usgsEarthquakes } from "./usgs-earthquakes";
import type { SourceAdapter, SourceFeature, SourceKind } from "./types";

/**
 * The source registry.
 *
 * The one import the worker and the map need. **Adding a source is one entry in this array
 * and one file next to it — no map component, route or query is touched.** That constraint is
 * the entire point of `types.ts`, and this array is where it either holds or quietly stops
 * holding, so it is worth checking against when adding the next one.
 *
 * Every adapter listed here has a terms record in `docs/sources/<slug>.md` stating its
 * licence, its attribution string, its documented rate limit, its key requirement and the
 * date the terms were read. Sources that were examined and NOT wired are recorded in
 * `docs/sources/HANDOFF.md` with the reason — that list is as useful as this one, because it
 * is what stops the same unverifiable source being re-proposed every quarter.
 */
export const SOURCE_ADAPTERS: readonly SourceAdapter<SourceFeature>[] = [
  usgsEarthquakes,
  nwsAlerts,
  adsbLol,
  radioBrowser,
  trafficCameras,
  nasaFirms,
];

/** Look one up by slug. Returns undefined rather than throwing for an unknown layer. */
export function findAdapter(slug: string): SourceAdapter<SourceFeature> | undefined {
  return SOURCE_ADAPTERS.find((adapter) => adapter.slug === slug);
}

/** Every adapter of one kind, for grouping the layer legend. */
export function adaptersOfKind(kind: SourceKind): readonly SourceAdapter<SourceFeature>[] {
  return SOURCE_ADAPTERS.filter((adapter) => adapter.kind === kind);
}

/**
 * Adapters that cannot run in this deployment because their key is unset.
 *
 * An operator dashboard should show these as "not configured" rather than "broken": a missing
 * key is a deployment choice, and ADR 0018 requires the build to succeed without runtime
 * secrets. Rendering it as a fault trains operators to ignore faults.
 */
export function unconfiguredAdapters(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly SourceAdapter<SourceFeature>[] {
  return SOURCE_ADAPTERS.filter(
    (adapter) => adapter.apiKeyEnvVar !== undefined && !env[adapter.apiKeyEnvVar]?.trim(),
  );
}

export { createMemoryCache } from "./cache";
export { describeFailure } from "./adapter";
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

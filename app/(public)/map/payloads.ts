import type { SourceQuery } from "@/lib/sources/types";
import { featurePrecision } from "@/components/map/registry";
import type { LayerPayloadDto, MapLayerDefinition } from "@/components/map/registry";
import { loadSource, resolveAdapter } from "./sources";

/**
 * One layer's data as a client DTO. Shared by the page and `data/[slug]/route.ts` so both
 * produce the same shape.
 */
export async function buildLayerPayload(
  layer: MapLayerDefinition,
  query: SourceQuery,
): Promise<LayerPayloadDto> {
  const adapter = resolveAdapter(layer.sourceSlug);

  // No adapter, or not configured here. No request was made, so this isn't an upstream error.
  if (!adapter) {
    return {
      layerId: layer.id,
      source: null,
      ok: false,
      failure: { kind: "notConfigured", missingEnvVar: `an adapter for "${layer.sourceSlug}"` },
      lastGoodAt: null,
    };
  }

  // `loadSource` shouldn't throw, but guard against adapter bugs anyway.
  try {
    /*
     * Pass the layer's precision fallback so cached features carry it; some adapters don't set
     * `SourceFeature.precision`, and snapshots/exports read the feature directly.
     */
    const { result, stale, ttlSeconds, attribution } = await loadSource(adapter, query, (feature) =>
      featurePrecision(layer, feature),
    );

    /*
     * Attribution and TTL come from the governed poll, not adapter constants: the registry
     * row's `cache_ttl_seconds` can be changed without a deploy and is authoritative.
     */
    const source = {
      slug: adapter.slug,
      name: adapter.name,
      homepage: adapter.homepage,
      attribution: {
        text: attribution.text,
        ...(attribution.href === undefined ? {} : { href: attribution.href }),
        licence: attribution.licence,
      },
      ttlSeconds,
    };

    if (result.ok) {
      return {
        layerId: layer.id,
        source,
        ok: true,
        features: result.features,
        observedAt: result.observedAt.toISOString(),
        /* From the cache wrapper, never from the adapter. See `registry/types.ts`. */
        stale,
      };
    }
    return {
      layerId: layer.id,
      source,
      ok: false,
      failure: result.failure,
      lastGoodAt: result.lastGoodAt?.toISOString() ?? null,
    };
  } catch (error) {
    // The poll threw, so fall back to the adapter's own attribution and TTL.
    return {
      layerId: layer.id,
      source: {
        slug: adapter.slug,
        name: adapter.name,
        homepage: adapter.homepage,
        attribution: {
          text: adapter.attribution.text,
          ...(adapter.attribution.href === undefined ? {} : { href: adapter.attribution.href }),
          licence: adapter.attribution.licence,
        },
        ttlSeconds: adapter.ttlSeconds,
      },
      ok: false,
      failure: {
        kind: "upstreamError",
        message: error instanceof Error ? error.message : "the adapter threw",
      },
      lastGoodAt: null,
    };
  }
}

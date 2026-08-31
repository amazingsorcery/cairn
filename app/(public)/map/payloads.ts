import type { SourceQuery } from "@/lib/sources/types";
import type { LayerPayloadDto, MapLayerDefinition } from "@/components/map/registry";
import { loadSource, resolveAdapter } from "./sources";

/**
 * One layer's data, as the DTO the client understands.
 *
 * Used by both the page (server render) and `data/[slug]/route.ts` (the refresh tick), so the
 * two cannot produce different shapes for the same layer — which is the bug that makes a
 * refresh silently blank a table.
 */
export async function buildLayerPayload(
  layer: MapLayerDefinition,
  query: SourceQuery,
): Promise<LayerPayloadDto> {
  const adapter = resolveAdapter(layer.sourceSlug);

  /*
   * A registry entry whose adapter has not landed yet, or whose source is not configured in
   * this deployment. `notConfigured` is the honest kind: nothing is broken and no request was
   * made. It names the missing piece rather than saying "unavailable", because "unavailable"
   * would blame an upstream that was never called.
   */
  if (!adapter) {
    return {
      layerId: layer.id,
      source: null,
      ok: false,
      failure: { kind: "notConfigured", missingEnvVar: `an adapter for "${layer.sourceSlug}"` },
      lastGoodAt: null,
    };
  }

  const source = {
    slug: adapter.slug,
    name: adapter.name,
    homepage: adapter.homepage,
    /*
     * ATTRIBUTION COMES FROM THE ADAPTER. It is never typed into a component and never
     * restated here, so the UI cannot render a layer without the credit its licence
     * requires. Several of these licences — adsb.lol's ODbL among them — make attribution a
     * condition of use, so a missing line is a licence breach and not a polish defect.
     */
    attribution: {
      text: adapter.attribution.text,
      ...(adapter.attribution.href === undefined ? {} : { href: adapter.attribution.href }),
      licence: adapter.attribution.licence,
    },
    ttlSeconds: adapter.ttlSeconds,
  };

  /*
   * `loadSource` returns a typed failure rather than throwing, but an adapter is code this
   * component does not own and a bug in one must not take the page down with it. One layer,
   * one boundary.
   */
  try {
    const { result, stale } = await loadSource(adapter, query);
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
    return {
      layerId: layer.id,
      source,
      ok: false,
      failure: {
        kind: "upstreamError",
        message: error instanceof Error ? error.message : "the adapter threw",
      },
      lastGoodAt: null,
    };
  }
}

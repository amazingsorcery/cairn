import type { SourceQuery } from "@/lib/sources/types";
import { featurePrecision } from "@/components/map/registry";
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

  /*
   * `loadSource` returns a typed failure rather than throwing, but an adapter is code this
   * component does not own and a bug in one must not take the page down with it. One layer,
   * one boundary.
   */
  try {
    /*
     * THE LAYER'S PRECISION FALLBACK GOES IN WITH THE QUERY, so the cached feature carries
     * the caveat the panel would have rendered. Several adapters have not adopted
     * `SourceFeature.precision` yet, and everything outside the map — a workspace snapshot,
     * an export — reads the feature rather than calling `featurePrecision`. See `loadSource`.
     */
    const { result, stale, ttlSeconds, attribution } = await loadSource(adapter, query, (feature) =>
      featurePrecision(layer, feature),
    );

    /*
     * ATTRIBUTION AND TTL COME FROM THE GOVERNED POLL, not from the adapter constants.
     *
     * `pollSource` returns the credit precisely so a caller cannot render a layer without it,
     * and it returns the registry row's `cache_ttl_seconds` because that is the number an
     * operator can change under load without a deploy (ADR 0024). For adsb.lol the row says
     * 60s where the adapter says 30s; reading the adapter here would poll twice as fast as
     * the operator asked, which is the whole reason the row is authoritative.
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
    /*
     * The governed poll itself threw, so there is no authorised credit or TTL to report. The
     * adapter's own constants are the honest fallback: they are what the source declares
     * about itself, and the alternative is a layer with no source line at all.
     */
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

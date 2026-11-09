import { FolderPlus } from "lucide-react";

import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition } from "./registry";

/**
 * "Save to a case" control.
 *
 * A native `<form method="get">` rather than a Server Action: a client `onClick` does nothing
 * before hydration, and `<form action={serverAction}>` is a background fetch that's lost if
 * the reader navigates away. This works without JS and adds no client code.
 *
 * It goes to `/map/save` instead of opening a picker here because listing cases needs
 * `auth()`, and public routes like `/map` never read the session (same pattern as
 * `/tools/[slug]/save`).
 *
 * Shown to signed-out readers (the picker sends them to sign-in and back). `FeatureDetail`
 * hides it in public-only mode, where `/map/save` isn't served.
 *
 * Only `sourceSlug` and the feature id are sent. The server resolves coordinates,
 * attribution and licence from the cache, so a crafted request can't strip attribution.
 */
export function SaveFeature<F extends SourceFeature>({
  layer,
  feature,
}: {
  /* Generic for the same reason `FeatureDetail` is: a layer is typed by its feature. */
  layer: MapLayerDefinition<F>;
  feature: F;
}) {
  /* Dev-only layers (synthetic data) can't be saved to a case. */
  if (layer.devOnly) return null;

  return (
    <form method="get" action="/map/save" className="mt-4">
      <input type="hidden" name="source" value={layer.sourceSlug} />
      <input type="hidden" name="feature" value={feature.id} />
      <button
        type="submit"
        className="border-input hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-11 items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <FolderPlus className="size-4 shrink-0" aria-hidden="true" />
        {/* Screen-reader label names the feature, since controls are heard out of context. */}
        save to a case
        <span className="sr-only">: {feature.label}</span>
      </button>
    </form>
  );
}

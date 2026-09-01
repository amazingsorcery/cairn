import { FolderPlus } from "lucide-react";

import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition } from "./registry";

/**
 * "Save this to a case" — the join between the Live pillar and the Workspaces pillar.
 *
 * ## Why it is a plain GET form and not a button that calls a Server Action
 *
 * `docs/frontend/HANDOFF-directory.md` §1b records two implementations of the equivalent
 * control on `/tools/[slug]` that the E2E suite rejected, and both failures are invisible in
 * a browser you are watching:
 *
 *   1. a client `onClick` calling the action — a tap between the HTML arriving and React
 *      attaching does nothing at all, silently;
 *   2. `<form action={serverAction}>` — React intercepts the submit as a background `fetch`,
 *      so navigating away in the moment after clicking drops the connection and loses the
 *      save with the button already showing pressed.
 *
 * This is a native `<form method="get">`. The browser commits to the navigation before it
 * leaves the page, React never intercepts it, and it works with the bundle removed. It adds
 * **zero bytes** of client JavaScript: no state, no handler, no `use client` of its own — it
 * renders inside one because `feature-detail.tsx` is one, not because it needs to be.
 *
 * ## Why it goes to a route rather than opening a dialog here
 *
 * A picker listing the reader's own cases needs `auth()`, and `sitemap.md` §10.1 makes it a
 * route-level invariant that no public route reads the session. `/map` is public. A child
 * segment is `force-dynamic` on its own without touching its parent, which is the same shape
 * `/tools/[slug]/save` and `/playbooks/[slug]` already use — one pattern, not a third.
 *
 * ## It renders for signed-out readers too
 *
 * The picker handles that state and sends them to sign-in with a `callbackUrl` back to
 * itself. Hiding the control until a reader signs in means they never learn the feature
 * exists; showing them a dead one means they learn it does not work.
 *
 * ## What crosses the wire
 *
 * The layer's `sourceSlug` and the feature's own id. Nothing else — not the coordinates, not
 * the observation instant, and above all not the attribution or the licence. The server
 * resolves all of it from the same cache entry the map was drawn from (ADR 0025, QA finding
 * QV-14). A licence obligation sourced from a request body is a licence obligation a crafted
 * request can blank.
 */
export function SaveFeature<F extends SourceFeature>({
  layer,
  feature,
}: {
  /* Generic for the same reason `FeatureDetail` is: a layer is typed by its feature. */
  layer: MapLayerDefinition<F>;
  feature: F;
}) {
  /*
   * A DEVELOPMENT-ONLY LAYER IS NOT SAVABLE. The stress harness generates 10,000 synthetic
   * points in this process; putting one into a case file would be fabricated content in the
   * one artefact the reader keeps (product-brief §6). The layer is already dropped from a
   * production build, so this only affects what a developer can do on their own machine —
   * which is exactly where the mistake would be made.
   */
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
        {/*
          The label names the thing, because a screen-reader user moving by controls hears
          this out of context and "save to a case" alone does not say which of the fourteen
          features on the panel behind it.
        */}
        save to a case
        <span className="sr-only">: {feature.label}</span>
      </button>
    </form>
  );
}

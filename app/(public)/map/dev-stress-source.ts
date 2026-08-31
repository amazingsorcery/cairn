import { z } from "zod";

import type { SourceAdapter, SourceFeature, SourceResult } from "@/lib/sources/types";
import { STRESS_LAYER_ID } from "@/components/map/registry/stress";

/**
 * Ten thousand synthetic points, for measuring the renderer's frame cost. **Development
 * only** — `resolveAdapter` in `sources.ts` will not return it in a production build, and
 * `MAP_LAYERS` drops its registry entry there too. Both gates are on `process.env.NODE_ENV`,
 * which the bundler inlines, so the branches are removed rather than merely unreachable.
 *
 * ## Why it exists
 *
 * The aircraft layer has to hold 10,000+ points without dropping frames. Without a way to
 * load the renderer before that source is wired, "deck.gl can do it" stays an assertion
 * until the layer that depends on it is already written. This makes it a measurement, and
 * `docs/frontend/HANDOFF-map.md` §5 records what it produced and on what hardware so a later
 * regression has a number to fail against.
 *
 * ## Why it is also the proof that the registry is data
 *
 * This layer was added by writing two files and one line in `registry/index.ts`. No map
 * component changed. That is the registry claim, exercised rather than asserted.
 */

const STRESS_POINTS = 10_000;

export const devStressSource: SourceAdapter<SourceFeature> = {
  slug: STRESS_LAYER_ID,
  name: "Synthetic renderer stress test",
  kind: "infrastructure",
  homepage: "https://deck.gl/docs/api-reference/layers/scatterplot-layer",
  attribution: {
    text: "Synthetic data. Not a source, and not about anything.",
    licence: "n/a — generated locally",
  },
  ttlSeconds: 3600,
  /**
   * Development-only synthetic source; the value is arbitrary but must exist.
   */
  staleWhileRevalidateSeconds: 60,
  responseSchema: z.never(),

  normalise: () => generate(),

  async fetch(): Promise<SourceResult<SourceFeature>> {
    return { ok: true, features: generate(), observedAt: new Date() };
  },

  async healthcheck() {
    return { ok: true, detail: "generated locally; no upstream" };
  },
};

/**
 * Deterministic rather than random: the same ten thousand points every time, so two
 * measurements are comparable and a screenshot can be reproduced. A plain linear congruential
 * generator, because this needs to be repeatable rather than unpredictable.
 */
function generate(): readonly SourceFeature[] {
  let seed = 20260831;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const features: SourceFeature[] = [];
  for (let index = 0; index < STRESS_POINTS; index += 1) {
    features.push({
      id: `stress-${index}`,
      kind: "infrastructure",
      longitude: next() * 360 - 180,
      latitude: next() * 140 - 70,
      label: `Synthetic point ${index}`,
      properties: { index },
    });
  }
  return features;
}

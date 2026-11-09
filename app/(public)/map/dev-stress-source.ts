import { z } from "zod";

import type { SourceAdapter, SourceFeature, SourceResult } from "@/lib/sources/types";
import { STRESS_LAYER_ID } from "@/components/map/registry/stress";

/**
 * 10,000 synthetic points for measuring renderer frame cost. Development only: both
 * `resolveAdapter` and `MAP_LAYERS` gate on `process.env.NODE_ENV`, which the bundler
 * inlines, so it's stripped from production builds.
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

/** Seeded LCG so every run produces the same points and measurements are comparable. */
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

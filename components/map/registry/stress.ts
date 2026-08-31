import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, Rgba } from "./types";
import { numberProp } from "./props";

/**
 * A synthetic 10,000-point layer, for measuring frame cost. **Development only.**
 *
 * ## Why this exists
 *
 * The aircraft layer has to hold 10,000+ points without dropping frames, and aircraft are
 * not the first source landing. Without a way to load the renderer now, "deck.gl can do it"
 * stays an assertion until the layer that depends on it is already written. This makes it a
 * measurement: `docs/frontend/HANDOFF-map.md` §5 records what it produced and on what
 * hardware, so a later regression has a number to fail against.
 *
 * ## Why it is also the proof that the registry works
 *
 * This layer was added by writing one file and one line in `index.ts`. No component changed.
 * That is the registry claim, exercised rather than asserted — and `registry.test.ts` fails
 * if any component in `components/map/` ever names a layer id.
 *
 * ## Why it cannot reach a reader
 *
 * `devOnly` is filtered out of `MAP_LAYERS` when `NODE_ENV` is `production`, and its adapter
 * in `app/(public)/map/dev-stress-source.ts` is only resolved under the same condition. Both gates are
 * build-time constants, so the bundler drops the branch entirely. Synthetic data on a
 * shipped path would be fabricated content on a product whose entire value is credibility
 * (product-brief §6); two gates for one dev tool is the right ratio.
 */

/** --slate-450 #74899E and --slate-600 #425468 — deliberately drab. It is not real data. */
const STRESS_DARK: Rgba = [116, 137, 158, 200];
const STRESS_LIGHT: Rgba = [66, 84, 104, 200];

export const STRESS_LAYER_ID = "dev-stress";

export const stressLayer: MapLayerDefinition = {
  id: STRESS_LAYER_ID,
  sourceSlug: "dev-stress",
  kind: "infrastructure",
  label: "Renderer stress test (development only)",
  description:
    "Ten thousand synthetic points with no meaning, used to measure the renderer's frame cost. Never present in a production build.",
  defaultVisible: false,
  colour: { dark: STRESS_DARK, light: STRESS_LIGHT, token: "--slate-450 / --slate-600" },
  legend: {
    label: "Renderer stress test",
    symbol: "circle",
    note: "Synthetic points. Not data about anything.",
  },
  deck: (kit, input) =>
    new kit.ScatterplotLayer<SourceFeature>({
      id: input.id,
      data: input.features,
      pickable: true,
      stroked: false,
      filled: true,
      radiusUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      getRadius: 3,
      getFillColor: input.colour,
      updateTriggers: { getFillColor: [input.colour] },
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),
  columns: [
    {
      key: "label",
      label: "point",
      numeric: false,
      rowHeader: true,
      initialDirection: "asc",
      value: (f) => f.label,
    },
    {
      key: "index",
      label: "index",
      numeric: true,
      initialDirection: "asc",
      value: (f) => numberProp(f, "index"),
    },
  ],
  detail: [
    { label: "Identifier", value: (f) => f.id, mono: true },
    {
      label: "Position",
      value: (f) => `${f.latitude.toFixed(4)}, ${f.longitude.toFixed(4)}`,
      mono: true,
    },
  ],
  defaultSort: { key: "index", direction: "asc" },
  emptyMessage: "The stress generator produced no points.",
  unavailableTitle: "Stress test unavailable",
  devOnly: true,
};

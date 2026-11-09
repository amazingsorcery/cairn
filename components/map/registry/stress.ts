import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, Rgba } from "./types";
import { numberProp } from "./props";

/**
 * Synthetic 10,000-point layer for measuring renderer frame cost. Development only.
 *
 * `devOnly` is filtered out of `MAP_LAYERS` in production, and its adapter
 * (`app/(public)/map/dev-stress-source.ts`) is gated the same way; both are build-time
 * constants, so the code is dropped from production bundles.
 */

/** --slate-450 #74899E and --slate-600 #425468; drab because it isn't real data. */
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

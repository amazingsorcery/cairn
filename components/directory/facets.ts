import { confidenceLabel } from "@/components/confidence-chip";
import {
  CONFIDENCE_LEVELS,
  COST_MODELS,
  type ConfidenceLevel,
  type CostModel,
} from "@/db/schema";
import { INPUT_TYPES, OUTPUT_TYPES } from "@/lib/validation/vocabulary";

/**
 * Directory facet groups, order and display labels.
 *
 * Value lists are imported from the schema/vocabulary modules so they can't drift.
 * Confidence labels come from `confidenceLabel()` to match the chip.
 */

/** The `searchParams` key each facet group writes. Matches `parseDirectoryFilters`. */
export const FACET_KEYS = ["category", "tag", "cost", "input", "output", "confidence"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

/** `freeWithRegistration` is spelled out: registering identifies you to the operator. */
const COST_LABELS: Record<CostModel, string> = {
  free: "free",
  freeWithRegistration: "free with registration",
  freemium: "freemium",
  paid: "paid",
  subscription: "subscription",
  enterprise: "enterprise",
};

export function costLabel(value: string): string {
  return (COST_MODELS as readonly string[]).includes(value)
    ? COST_LABELS[value as CostModel]
    : value;
}

/** Input/output types are stored kebab-case; display them as words. */
export function typeLabel(value: string): string {
  return value.replace(/-/g, " ");
}

export function confidenceValueLabel(value: string): string {
  return (CONFIDENCE_LEVELS as readonly string[]).includes(value)
    ? confidenceLabel(value as ConfidenceLevel).toLowerCase()
    : value;
}

/** The short prefix a removable filter chip carries, e.g. `cost: free`. */
export const FACET_CHIP_PREFIX: Record<FacetKey | "q", string> = {
  q: "name",
  category: "category",
  tag: "tag",
  cost: "cost",
  input: "input",
  output: "output",
  confidence: "confidence",
};

export const COST_OPTIONS: readonly string[] = COST_MODELS;
export const CONFIDENCE_OPTIONS: readonly string[] = CONFIDENCE_LEVELS;
export const INPUT_OPTIONS: readonly string[] = INPUT_TYPES;
export const OUTPUT_OPTIONS: readonly string[] = OUTPUT_TYPES;

/**
 * `outputTypes: ['none']` is a real category (OPSEC tools such as browsers or password
 * managers), not "no data".
 */
export const OUTPUT_NOTE =
  "Output type none is a real category: the entry protects the investigator rather than yielding evidence.";

export const SORT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "name", label: "name" },
  { value: "relevance", label: "relevance" },
  { value: "recent", label: "recently published" },
  { value: "reliability", label: "editorial reliability" },
];

export function sortLabel(value: string): string {
  return SORT_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

import { confidenceLabel } from "@/components/confidence-chip";
import {
  CONFIDENCE_LEVELS,
  COST_MODELS,
  type ConfidenceLevel,
  type CostModel,
} from "@/db/schema";
import { INPUT_TYPES, OUTPUT_TYPES } from "@/lib/validation/vocabulary";

/**
 * The facet vocabulary as the directory renders it: which groups exist, in what order, and
 * what each stored value is called on screen.
 *
 * The value lists are IMPORTED, never retyped. `COST_MODELS` and `CONFIDENCE_LEVELS` carry
 * Postgres CHECK constraints (`db/schema.ts`); `INPUT_TYPES` and `OUTPUT_TYPES` are the open
 * vocabularies the content-strategist grows in `lib/content/schema.ts`. A hand-written copy
 * here would drift on the first addition and the symptom would be a facet that silently
 * cannot find the entries it is named after.
 *
 * Labels are sentence case with no title case anywhere (`docs/brand/voice.md` §5), and the
 * four confidence labels come from `confidenceLabel()` so the chip and the checkbox beside
 * it can never disagree about what a level is called.
 */

/** The `searchParams` key each facet group writes. Matches `parseDirectoryFilters`. */
export const FACET_KEYS = ["category", "tag", "cost", "input", "output", "confidence"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

/**
 * `freeWithRegistration` is a threat-model fact rather than a pricing tier — the operator
 * learns who you are before you get a result — so it is spelled out rather than abbreviated.
 */
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

/**
 * Input and output types are kebab-case in storage because they are an open `text[]`
 * vocabulary the content grows (`lib/validation/vocabulary.ts`). On screen they are words.
 */
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
 * Architecture HANDOFF §9.8: `outputTypes: ['none']` is a category, not an empty state.
 * Tradecraft and OPSEC entries — a browser, an encrypted volume, a password manager —
 * protect the investigator rather than yielding evidence. The group carries this line so a
 * reader does not read the checkbox as "no data".
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

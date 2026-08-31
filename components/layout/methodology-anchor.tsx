import Link from "next/link";

import { ConfidenceChip } from "@/components/confidence-chip";
import type { ConfidenceLevel } from "@/db/schema";

/**
 * Where a confidence chip points.
 *
 * `/methodology` is load-bearing (ADR 0007 §4, architecture HANDOFF §9.4): it is the page
 * that defines what each confidence level means, what the 1–5 reliability scale means, and
 * what `lastVerifiedAt` promises. Every confidence badge in the product links to the
 * matching anchor on it.
 *
 * The three spellings are all correct in their own layer and this map is the single
 * translation point between two of them, exactly as `components/confidence-chip.tsx` is
 * for the third:
 *
 *   stored value   `needsReview`   (camelCase — `CONFIDENCE_LEVELS` in `db/schema.ts`)
 *   URL fragment   `needs-review`  (kebab — it is a URL fragment)
 *   label          "Needs review"  (`confidenceLabel()`)
 *
 * Typing the map as `Record<ConfidenceLevel, string>` means adding a fifth level to the
 * schema fails the build here rather than producing a chip that links nowhere.
 */

export const METHODOLOGY_PATH = "/methodology";

export const CONFIDENCE_ANCHOR: Record<ConfidenceLevel, string> = {
  verified: "verified",
  high: "high",
  medium: "medium",
  needsReview: "needs-review",
};

/** What the editorial 1–5 scale means, and that it is not a user rating. */
export const RELIABILITY_ANCHOR = "reliability";

/** What the verification date promises and what it does not. */
export const LAST_VERIFIED_ANCHOR = "last-verified";

/** `/methodology#high`. Use this rather than building the fragment by hand. */
export function confidenceAnchorHref(level: ConfidenceLevel): string {
  return `${METHODOLOGY_PATH}#${CONFIDENCE_ANCHOR[level]}`;
}

export function methodologyAnchorHref(anchor: string): string {
  return `${METHODOLOGY_PATH}#${anchor}`;
}

export interface ConfidenceChipLinkProps {
  level: ConfidenceLevel;
  /** Hide the meter where space is tight, e.g. a dense table row. Never hide the label. */
  showMeter?: boolean;
  className?: string;
}

/**
 * The confidence chip as a link to its definition. **Use this wherever an entry appears** —
 * directory card, detail page, search result row, camera entry — rather than rendering
 * `ConfidenceChip` bare. A chip that states a level without a route to what the level means
 * is a claim the reader cannot check, which is the one thing this product may not do.
 *
 * The chip is never the only signal of uncertainty in a row: the last-verified line always
 * sits beside it (`docs/design/wireframes/00-conventions.txt`).
 */
export function ConfidenceChipLink({ level, showMeter, className }: ConfidenceChipLinkProps) {
  return (
    <Link
      href={confidenceAnchorHref(level)}
      className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <ConfidenceChip
        level={level}
        {...(showMeter === undefined ? {} : { showMeter })}
        {...(className === undefined ? {} : { className })}
      />
      <span className="sr-only"> Read what this level means.</span>
    </Link>
  );
}

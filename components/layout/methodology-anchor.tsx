import Link from "next/link";

import { ConfidenceChip } from "@/components/confidence-chip";
import type { ConfidenceLevel } from "@/db/schema";

/**
 * Links from confidence chips to their definitions on `/methodology`.
 *
 * Maps stored values (`needsReview`) to URL fragments (`needs-review`). Typed as
 * `Record<ConfidenceLevel, string>` so a new level fails the build here.
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
 * Confidence chip linked to its definition. Use this instead of a bare `ConfidenceChip`
 * wherever an entry appears.
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

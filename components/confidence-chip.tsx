import { ShieldAlert, ShieldCheck, ShieldHalf, ShieldQuestion } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { CONFIDENCE_LEVELS, type ConfidenceLevel } from "@/db/schema";
import { cn } from "@/lib/utils";

/**
 * How sure we are about a catalogue entry. The most-repeated coloured element in the
 * product, and the one where a misread is a misread claim.
 *
 * The ramp is a monotonic luminance staircase, so it stays *ordered* under every form of
 * colour vision deficiency. Colour is the third channel, never the first: every chip
 * renders a filled-segment meter, a word, and an icon, so it survives greyscale printing,
 * a monochrome screenshot, and a reader who sees no colour at all.
 *
 * `high` is deliberately neutral grey. It is the commonest value, defaults should not
 * spend colour, and it guarantees a chip can never be mistaken for a link.
 *
 * `needsReview` is the chromatically quietest step because the staircase requires it, so
 * it carries the two structural signals instead: the only dashed border, the only fill.
 *
 * Three spellings, one per layer, all deliberate: the stored value is `needsReview`
 * (CONFIDENCE_LEVELS in db/schema.ts), the token stem is `review`, the label reads
 * "Needs review". The map below is the single translation point.
 *
 * EVERY `meaning` BELOW HAS OUR RECORD AS ITS SUBJECT, never the tool. A hostile audit found
 * `needsReview` reading as "confirm before relying on it", which a reader takes as a warning
 * about the tool — the precise confusion `docs/design/states.md` §3.4 exists to prevent.
 * Confidence says how sure WE are about what WE wrote down; `lastVerifiedAt` says when we
 * last looked; neither is a rating of the tool. `tools.reliability` is the rating, and it is
 * a separate field. If you edit these strings, keep the grammatical subject on us.
 *
 * The strings say "entry", not "tool", because this chip renders over playbooks as well as
 * over catalogue entries — and on `/playbooks/[slug]` the reader is looking at a *method*.
 * "Not a judgement about the tool" reads slightly wrong there. One canonical wording that is
 * correct on both surfaces beats a local restatement on either, which is what Q-16 was about
 * in the first place.
 *
 * Specified in docs/brand/HANDOFF.md section 3 and docs/design/tokens.md section 3.
 */

interface ConfidencePresentation {
  readonly label: string;
  readonly filled: 1 | 2 | 3 | 4;
  readonly icon: LucideIcon;
  /** What the level actually means, for the tooltip and the accessible description. */
  readonly meaning: string;
}

const PRESENTATION: Record<ConfidenceLevel, ConfidencePresentation> = {
  verified: {
    label: "Verified",
    filled: 4,
    icon: ShieldCheck,
    meaning:
      "We checked this entry against the primary source when it was last reviewed.",
  },
  high: {
    label: "High",
    filled: 3,
    icon: ShieldHalf,
    meaning:
      "We are confident in this entry: it is long-established and widely documented, " +
      "though we did not re-check it this cycle.",
  },
  medium: {
    label: "Medium",
    filled: 2,
    icon: ShieldAlert,
    meaning:
      "Our record of this entry may be out of date in a detail such as pricing or " +
      "availability. The entry itself is real.",
  },
  needsReview: {
    label: "Needs review",
    filled: 1,
    icon: ShieldQuestion,
    meaning:
      "Our record of this entry is materially uncertain. Confirm the details against the " +
      "source before relying on them. This is not a judgement about the entry itself.",
  },
};

/**
 * Token stems differ from stored values by design (needsReview maps to review), so class
 * strings are written out in full rather than interpolated — Tailwind only ever emits
 * class names it can see literally in the source.
 */
const CHIP_CLASS: Record<ConfidenceLevel, string> = {
  verified: "border-confidence-verified text-confidence-verified",
  high: "border-confidence-high text-confidence-high",
  medium: "border-confidence-medium text-confidence-medium",
  needsReview:
    "border-dashed border-confidence-review text-confidence-review bg-confidence-review-surface",
};

const SEGMENT_CLASS: Record<ConfidenceLevel, string> = {
  verified: "bg-confidence-verified",
  high: "bg-confidence-high",
  medium: "bg-confidence-medium",
  needsReview: "bg-confidence-review",
};

export function confidenceLabel(level: ConfidenceLevel): string {
  return PRESENTATION[level].label;
}

export function confidenceMeaning(level: ConfidenceLevel): string {
  return PRESENTATION[level].meaning;
}

export interface ConfidenceChipProps {
  level: ConfidenceLevel;
  /** Hide the meter where space is tight, e.g. a dense table row. Never hide the label. */
  showMeter?: boolean;
  className?: string;
}

export function ConfidenceChip({ level, showMeter = true, className }: ConfidenceChipProps) {
  const { label, filled, icon: Icon, meaning } = PRESENTATION[level];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "text-[13px] font-semibold leading-none",
        CHIP_CLASS[level],
        className,
      )}
      title={meaning}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">Our confidence in this entry: </span>
      {label}
      <span className="sr-only">. {meaning}</span>
      {showMeter ? (
        <span data-testid="confidence-meter" className="ml-0.5 inline-flex gap-0.5" aria-hidden="true">
          {[1, 2, 3, 4].map((segment) => (
            <span
              key={segment}
              className={cn(
                "h-2.5 w-1 rounded-[1px]",
                segment <= filled ? SEGMENT_CLASS[level] : "bg-confidence-track",
              )}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** Every level, in ramp order. For legends on /methodology and for filter controls. */
export const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = CONFIDENCE_LEVELS;

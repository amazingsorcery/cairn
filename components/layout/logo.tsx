import { brand } from "@/config/brand";
import { cn } from "@/lib/utils";

/**
 * The two brand marks, inlined as React components.
 *
 * Inlined rather than `<img src="/logo.svg">` for two reasons, both from
 * `docs/brand/logo/README.md` §3 and `docs/brand/HANDOFF.md` §5:
 *
 *   1. Both marks are drawn in `currentColor` and have no colour of their own. An `<img>`
 *      is an independent document and cannot inherit the page's `color`, so the theme
 *      toggle would not reach them.
 *   2. They cost no HTTP request. The header is on every page of the product.
 *
 * The `<title>` element from the source SVGs is stripped, as the handoff requires: the
 * accessible name comes from `brand.name`, so a rename stays a one-file change. Where the
 * mark sits beside the name in text it is `aria-hidden` instead, because announcing the
 * product name twice is noise.
 *
 * Geometry is copied verbatim from `docs/brand/logo/monogram.svg` and
 * `docs/brand/logo/wordmark.svg`. If either file changes, change it here in the same
 * commit — these are the only two places the mark exists.
 */

interface MarkProps {
  /**
   * Rendered size. The measured minimums are 16px for the monogram and 24px tall for the
   * wordmark (`logo/README.md` §2). Prefer multiples of 8 for the monogram: at 20px the
   * 2-unit gaps between the stones land on 1.25 device pixels and go soft.
   */
  className?: string;
  /**
   * `true` when the mark sits beside the product name in text, so the name is not
   * announced twice. `false` when the mark is the only thing carrying the name.
   */
  decorative?: boolean;
}

function accessibility(decorative: boolean) {
  return decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img" as const, "aria-label": brand.name });
}

/** Three stacked stones on a 32-unit grid. Square. Minimum 16px. */
export function Monogram({ className, decorative = false }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      className={cn("size-8 shrink-0", className)}
      {...accessibility(decorative)}
    >
      <rect x="12" y="4" width="8" height="6" rx="2" />
      <rect x="8" y="12" width="16" height="6" rx="2" />
      <rect x="4" y="20" width="24" height="8" rx="2" />
    </svg>
  );
}

/**
 * The name in drawn letterforms. There is no `<text>` element and no font dependency, so
 * the mark renders identically on a machine with no fonts installed. Minimum 24px tall.
 */
export function Wordmark({ className, decorative = false }: MarkProps) {
  return (
    <svg
      viewBox="0 0 206 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-8 w-auto shrink-0", className)}
      {...accessibility(decorative)}
    >
      <path d="M46.14 17.86A20 20 0 1 0 46.14 46.14" />
      <path d="M60 52 80 12 100 52" />
      <path d="M68.5 35H91.5" />
      <path d="M112 12V52" />
      <path d="M127 52V12H143A10 10 0 0 1 143 32H127" />
      <path d="M139 32 155 52" />
      <path d="M168 52V12L194 52V12" />
    </svg>
  );
}

/**
 * The header lockup: monogram plus the name set in the interface face.
 *
 * The wordmark is deliberately *not* used here. At header scale the drawn letterforms sit
 * next to nav labels in IBM Plex Sans, and two different renderings of the same alphabet
 * inches apart reads as a mistake. The wordmark's place is the Open Graph card and any
 * future print or presentation surface, where it stands alone.
 */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Monogram className="size-6 text-primary" decorative />
      <span className="text-base font-semibold tracking-tight">{brand.name}</span>
    </span>
  );
}

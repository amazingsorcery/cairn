import { brand } from "@/config/brand";
import { cn } from "@/lib/utils";

/**
 * Brand marks as inline SVG, so they inherit `currentColor` from the theme and cost no
 * request. The accessible name comes from `brand.name`; beside visible text the mark is
 * `aria-hidden`.
 */

interface MarkProps {
  /**
   * Rendered size. Minimums: 16px monogram, 24px tall wordmark. Prefer multiples of 8 for
   * the monogram; other sizes blur the gaps.
   */
  className?: string;
  /** `true` when the product name is already visible beside the mark. */
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

/** The name as drawn paths (no font dependency). Minimum 24px tall. */
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
 * Header lockup: monogram plus the name in the UI font. The wordmark is for standalone
 * use (e.g. the Open Graph card), not next to nav text.
 */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Monogram className="size-6 text-primary" decorative />
      <span className="text-base font-semibold tracking-tight">{brand.name}</span>
    </span>
  );
}

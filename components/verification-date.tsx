import { cn, formatDate, verificationAge } from "@/lib/utils";

/**
 * When a human last confirmed an entry is accurate.
 *
 * Architecture HANDOFF section 9.1 requires this everywhere an entry appears, showing an
 * absolute date *and* a relative age. Both, because they answer different questions: the
 * date is what you cite in a write-up, the age is whether to trust it.
 *
 * Two deliberate choices, both from ADR 0016:
 *
 * 1. Ageing and stale records use `--warning`, never `--destructive`. Destructive is the
 *    delete/revoke red, and on a directory row it reads as a judgement about the TOOL —
 *    the exact confusion this product cannot afford. `lastVerifiedAt` describes the
 *    freshness of OUR RECORD. A tool can be excellent and our note about it a year old.
 *    Escalation is carried by weight and by wording, which can say precisely what is and
 *    is not being claimed. Colour cannot.
 *
 * 2. The visible text is human-readable ("14 Aug 2026", unambiguous across US and UK
 *    reading order in a way a numeric format is not) and the `<time dateTime>` attribute
 *    carries full ISO 8601 for machines. Exports use ISO throughout, because those are
 *    evidence artefacts that get quoted, sorted and diffed.
 */

const STATUS_CLASS = {
  fresh: "text-muted-foreground",
  ageing: "text-warning",
  stale: "text-warning font-medium",
} as const;

function relativeAge(days: number): string {
  if (!Number.isFinite(days)) return "date unknown";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  const months = Math.round(days / 30.44);
  if (months < 24) return months === 1 ? "1 month ago" : `${months} months ago`;
  return `${Math.round(days / 365.25)} years ago`;
}

/** ISO 8601 calendar date for the `dateTime` attribute. */
function isoDate(value: Date | string): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

export interface VerificationDateProps {
  lastVerifiedAt: Date | string | null;
  className?: string;
}

export function VerificationDate({ lastVerifiedAt, className }: VerificationDateProps) {
  if (lastVerifiedAt === null) {
    return (
      <span className={cn("text-sm font-medium text-warning", className)}>
        Not yet verified — treat every detail here as unconfirmed
      </span>
    );
  }

  const { days, status } = verificationAge(lastVerifiedAt);
  const absolute = formatDate(lastVerifiedAt);
  const relative = relativeAge(days);

  return (
    <span className={cn("text-sm", STATUS_CLASS[status], className)}>
      <span className="sr-only">Our record was last confirmed accurate on </span>
      Last verified{" "}
      <time dateTime={isoDate(lastVerifiedAt)}>{absolute}</time>
      <span aria-hidden="true"> · {relative}</span>
      {status === "stale" ? (
        <>
          {" "}
          <span className="font-normal">— details may have changed since</span>
        </>
      ) : null}
    </span>
  );
}

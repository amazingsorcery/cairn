import { cn } from "@/lib/utils";
import { formatDate, verificationAge } from "@/lib/utils";

/**
 * When a human last confirmed an entry is accurate.
 *
 * Architecture HANDOFF section 9.1 requires this everywhere an entry appears, showing an
 * absolute date *and* a relative age. Both, because they answer different questions: the
 * date is what you cite in a write-up, the age is what tells you whether to trust it.
 *
 * The staleness thresholds live in `verificationAge` (lib/utils.ts) and are deliberately
 * unforgiving. A directory whose only real claim is "somebody checked this" has to be
 * conspicuously honest about how long ago that was — quietly ageing entries would let the
 * catalogue rot while still looking authoritative, which is the failure mode that would
 * cost us the audience.
 *
 * This describes the freshness of OUR RECORD, not the quality of the tool. The wording is
 * chosen so a stale entry never reads as a warning about the tool itself.
 */

const STATUS_CLASS = {
  fresh: "text-muted-foreground",
  ageing: "text-warning",
  stale: "text-destructive",
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

export interface VerificationDateProps {
  lastVerifiedAt: Date | string | null;
  className?: string;
}

export function VerificationDate({ lastVerifiedAt, className }: VerificationDateProps) {
  if (lastVerifiedAt === null) {
    return (
      <span className={cn("text-sm text-destructive", className)}>
        Never verified — treat every detail here as unconfirmed
      </span>
    );
  }

  const { days, status } = verificationAge(lastVerifiedAt);
  const absolute = formatDate(lastVerifiedAt);
  const relative = relativeAge(days);

  return (
    <span className={cn("text-sm", STATUS_CLASS[status], className)}>
      <span className="sr-only">Our record was last confirmed accurate on </span>
      Last verified {absolute}
      <span aria-hidden="true"> · {relative}</span>
      {status === "stale" ? (
        <span className="sr-only">
          . This is over a year old, so details may have changed since.
        </span>
      ) : null}
    </span>
  );
}

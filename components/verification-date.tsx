import { cn, formatDate, verificationAge } from "@/lib/utils";

/**
 * When an entry was last confirmed accurate, as an absolute date plus relative age.
 *
 * Stale records use `--warning`, never `--destructive`: this describes our record's age, not
 * the tool's quality. Visible text is "14 Aug 2026"; `<time dateTime>` carries ISO 8601.
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

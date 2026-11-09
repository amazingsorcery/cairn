import Link from "next/link";
import { Clock, ExternalLink, ShieldOff, ShieldQuestion } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { confidenceAnchorHref } from "@/components/layout/methodology-anchor";
import { isInsecureUrl } from "@/lib/content/schema";
import { cn, displayHost, verificationAge } from "@/lib/utils";

/**
 * Notices shown beside an entry's confidence chip and verification line, plus the outbound
 * link.
 *
 * Stale (when we last looked: `--warning`, `Clock`) and `needsReview` (how sure we are:
 * `--confidence-review`, `ShieldQuestion`) are separate claims and must look different.
 * Neither says the tool is bad; legal risk goes in `legalNotes`.
 */

/**
 * Staleness threshold in days. Display only; never written back to `confidence`.
 *
 * Differs from the 90/365 tiers `verificationAge()` uses for `VerificationDate` colour; this
 * is the single point where we show a notice.
 */
export const STALE_AFTER_DAYS = 180;

export function isStaleRecord(lastVerifiedAt: Date | string | null): boolean {
  if (lastVerifiedAt === null) return false;
  return verificationAge(lastVerifiedAt).days > STALE_AFTER_DAYS;
}

/** Copy is about our check being old, not about the tool. */
export function StaleRecordNotice({ lastVerifiedAt }: { lastVerifiedAt: Date | string | null }) {
  if (!isStaleRecord(lastVerifiedAt)) return null;

  return (
    <Alert variant="warning">
      <Clock aria-hidden="true" />
      <AlertTitle>Our last check is more than {STALE_AFTER_DAYS} days old</AlertTitle>
      <AlertDescription>
        <p>
          Details that move — pricing, availability, the API — may have changed since. The
          entry has not been re-checked.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** `default` variant, not `warning`, so it doesn't look like the staleness notice. */
export function NeedsReviewNotice({ reliabilityNotes }: { reliabilityNotes: string | null }) {
  return (
    <Alert variant="default" className="border-confidence-review">
      <ShieldQuestion aria-hidden="true" className="text-confidence-review" />
      <AlertTitle>Confidence: needs review</AlertTitle>
      <AlertDescription>
        <p>
          Something in this entry is materially uncertain and a human needs to re-check it —
          that is a statement about our record, not about the tool.
          {reliabilityNotes ? ` What we could not settle: ${reliabilityNotes}` : null}
        </p>
        <p className="mt-3">
          <Link
            href={confidenceAnchorHref("needsReview")}
            className="font-medium text-primary underline underline-offset-4"
          >
            Read what each level means
          </Link>
        </p>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Notice for plain-HTTP URLs: the request is visible in transit. URLs are never rewritten to
 * `https://`, which would break sites without TLS.
 */
export function InsecureTransportNotice({ url }: { url: string }) {
  if (!isInsecureUrl(url)) return null;

  return (
    <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-surface px-3 py-2 text-sm text-foreground">
      <ShieldOff aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>
        This link is <code className="font-mono text-xs">http://</code>, not{" "}
        <code className="font-mono text-xs">https://</code>. Your request to it, including the
        address, is visible in transit.
      </span>
    </p>
  );
}

/**
 * Outbound catalogue link showing the host. `noreferrer` hides which page sent the reader.
 *
 * No `nofollow ugc`: those are for user-authored content, and catalogue URLs are
 * editorially verified.
 */
export function ExternalToolLink({
  url,
  className,
  children,
}: {
  url: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-md font-mono text-sm",
        "text-primary underline-offset-4 hover:underline",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <span className="min-w-0 break-all">{children ?? displayHost(url)}</span>
      <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

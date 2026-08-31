import Link from "next/link";
import { Clock, ExternalLink, ShieldOff, ShieldQuestion } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { confidenceAnchorHref } from "@/components/layout/methodology-anchor";
import { isInsecureUrl } from "@/lib/content/schema";
import { cn, displayHost, verificationAge } from "@/lib/utils";

/**
 * The three notices that sit beside an entry's confidence chip and verification line, plus
 * the outbound link itself.
 *
 * `states.md` §3.4 is the load-bearing rule here: **stale and `needsReview` are orthogonal
 * claims and must not look alike.**
 *
 *   | | stale record | needsReview |
 *   | what it says | *when* we last looked | *how sure* we are of what we found |
 *   | where | the last-verified line only | the confidence chip only |
 *   | colour | `--warning` | `--confidence-review` |
 *   | icon | `Clock` | `ShieldQuestion` |
 *
 * Both can be true of one entry, and rendering them in one colour or one icon would collapse
 * two different claims into one. For this product that is a correctness bug, not a styling
 * preference. Neither is a warning that the tool is bad: no entry in this product carries
 * such a warning. Real legal risk is stated in `legalNotes`, which is a separate mechanism.
 */

/**
 * The staleness threshold from `states.md` §3.2, in days.
 *
 * It is **presentational only** and is never written back to `confidence`: an automatic
 * downgrade would be a claim no human made (ADR 0007 §5).
 *
 * 180 is this document's number. `verificationAge()` in `lib/utils.ts` ships a different,
 * three-tier scale (90 / 365) which `VerificationDate` uses for its colour. The two coexist
 * on purpose for now — the colour ramp is a gradient of concern, this is the single threshold
 * at which we say a sentence — and `states.md` §0 flags the reconciliation as the
 * content-strategist's to own. Recorded in `docs/frontend/HANDOFF-directory.md`.
 */
export const STALE_AFTER_DAYS = 180;

export function isStaleRecord(lastVerifiedAt: Date | string | null): boolean {
  if (lastVerifiedAt === null) return false;
  return verificationAge(lastVerifiedAt).days > STALE_AFTER_DAYS;
}

/**
 * `states.md` §3.2. The subject of every sentence is OUR CHECK, never the tool.
 *
 * Not "this tool may be unreliable". Not "outdated". No warning icon on the tool's name. The
 * tool is fine; our record is old, and those are different claims.
 */
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

/**
 * `states.md` §3.3. Note the variant: `default`, never `warning`. This is a statement about
 * our record, and dressing it in the same colour as the staleness notice would make the two
 * claims indistinguishable (§3.4).
 */
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
 * `states.md` §3.8 and architecture HANDOFF §9.7.
 *
 * A statement of fact, not a recommendation. We do not tell the reader whether to click — we
 * tell them what the transport does, because for this audience that is operational
 * information: anyone on the path can read the request, and the request itself reveals what
 * is being looked into.
 *
 * Detected from the stored URL scheme. The URL is stored accurately and never silently
 * upgraded: a directory that quietly rewrote `http://` to `https://` would be less honest,
 * not safer, and would break entries whose operators serve no TLS at all.
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
 * The outbound catalogue link.
 *
 * The host is **visible**, not hidden behind the tool's name, so a reader sees where they are
 * being sent before they go. `rel="noopener noreferrer"`: `noopener` denies the destination a
 * handle on our window, `noreferrer` means it is not told which page sent the reader — which
 * for this audience is the more important half.
 *
 * Deliberately without `nofollow ugc` — see `docs/frontend/HANDOFF-directory.md`. Shell
 * handoff §10.5 specifies that pair for Markdown bodies and user-authored content; a
 * catalogue URL is an editorially verified primary source, and marking it as untrusted
 * user-generated content would misdescribe the one link the entry exists to carry.
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

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * A failed region inside a page that still works — `states.md` §0 and shell handoff §10.3:
 * "Partial is a first-class state: a region that failed renders its own error inside the page
 * while the rest stays usable — do not promote a failed region to a whole-page error."
 *
 * For the directory that means the filter bar stays interactive while the results region
 * alone reports the failure (`states.md` §2.4). Promoting it to `error.tsx` would throw away
 * the reader's filter set, which is the one thing they would want to keep.
 *
 * `retry` is `router.refresh()`, not a link to the current URL: a link to the address you are
 * already on is a no-op the reader reads as a broken button. `refresh()` re-runs the Server
 * Component with the same `searchParams` and no cached RSC payload, which is what "retry"
 * has to mean here.
 */
export function RegionError({
  title,
  description,
  secondary,
}: {
  title: string;
  description: string;
  /** A second, non-retry way out — "clear all filters", "browse the directory". */
  secondary?: { label: string; href: string };
}) {
  const router = useRouter();

  return (
    <Alert variant="warning">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{description}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button size="sm" onClick={() => router.refresh()}>
            retry
          </Button>
          {secondary ? (
            <Button asChild size="sm" variant="outline">
              <Link href={secondary.href}>{secondary.label}</Link>
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

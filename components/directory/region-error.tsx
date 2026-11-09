"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * In-page error for one failed region, so the rest of the page (e.g. the filter bar) stays
 * usable. Retry uses `router.refresh()`, since a link to the current URL would be a no-op.
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

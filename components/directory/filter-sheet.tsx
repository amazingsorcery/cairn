"use client";

import * as React from "react";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

/**
 * Mobile filter sheet. Facets live in a full-height sheet so they don't push results below
 * the fold.
 *
 * The panel is a Server Component passed as `children`; this only owns open state. The
 * footer count is live: facets push the URL on change, so the server re-renders `total`
 * while the sheet stays open.
 */
export function FilterSheet({
  activeCount,
  total,
  clearHref,
  children,
}: {
  activeCount: number;
  total: number;
  clearHref: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full sm:w-auto"
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal aria-hidden="true" />
        {activeCount > 0 ? `filters (${activeCount})` : "filters"}
      </Button>

      <SheetContent side="left" className="flex flex-col" closeLabel="Close filters">
        <SheetTitle>filters</SheetTitle>
        <SheetDescription>
          Every filter is written into the address, so this view can be shared and the back
          button returns the previous set.
        </SheetDescription>

        <div className="min-h-0 flex-1">{children}</div>

        <div className="mt-4 flex gap-2 border-t border-border pt-4">
          <Button asChild variant="outline" size="lg">
            <Link href={clearHref}>clear all</Link>
          </Button>
          <SheetClose asChild>
            <Button size="lg" className="flex-1">
              {total === 1 ? "show 1 tool" : `show ${total} tools`}
            </Button>
          </SheetClose>
        </div>
      </SheetContent>
    </Sheet>
  );
}

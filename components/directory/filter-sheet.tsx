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
 * The 375px filter surface.
 *
 * `docs/design/wireframes/02-directory.txt` puts the facets in a full-height sheet at mobile
 * width, because at 375px they cannot sit beside the results and collapsing them into an
 * accordion above the list pushes the results themselves below the fold.
 *
 * The panel inside is a Server Component passed as `children` — this component owns the
 * open/closed state and nothing else. Radix's Dialog gives the focus trap, the escape key,
 * the scroll lock and `aria-modal`.
 *
 * The footer count is live because the facets push the URL on change: the server re-renders
 * with a new `total` while the sheet stays open, so "show 47 tools" is the number of results
 * currently waiting behind the sheet rather than a promise about a pending selection.
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

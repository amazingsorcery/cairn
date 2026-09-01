"use client";

import { useState } from "react";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AccountMenu } from "./account-menu";
import { SiteNavStacked } from "./site-nav";

/**
 * The 375px navigation. At `md` and above the links sit in the header itself and this is
 * hidden, so the same route table renders in both places and cannot drift.
 *
 * `Sheet` is Radix Dialog underneath, which brings focus trapping, Escape, scroll locking
 * and `aria-modal` with it. The panel is controlled rather than uncontrolled so that
 * following a link inside it closes it — an App Router navigation does not unmount the
 * sheet on its own, and a menu still covering the page the reader just asked for is the
 * commonest bug in this component.
 */
export function MobileNav({ signInEnabled }: { signInEnabled: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="open menu" className="md:hidden">
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        closeLabel="close menu"
        // Radix asks for a description; this panel is a list of links whose title says so.
        // A description would be read out before every link for no added information.
        aria-describedby={undefined}
      >
        <SheetTitle>menu</SheetTitle>
        <SiteNavStacked onNavigate={() => setOpen(false)} signInEnabled={signInEnabled} />
        {/*
          The separator belongs to the account control. In public-only mode that control
          renders nothing, and a rule under the last link with nothing after it is a visible
          hole where a reader expects something.
        */}
        {signInEnabled ? <Separator className="my-4" /> : null}
        {/* The theme toggle is not repeated here; it is in the header bar at every width. */}
        <AccountMenu signInEnabled={signInEnabled} />
      </SheetContent>
    </Sheet>
  );
}

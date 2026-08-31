"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A panel that slides in from an edge. Built on Radix Dialog rather than as a separate
 * primitive, so focus trapping, escape handling, scroll locking and aria-modal all come
 * from one well-tested implementation instead of two.
 *
 * Its job here is the mobile filter panel: on a 375px screen the directory facets cannot
 * sit beside the results, and collapsing them into an accordion above the list pushes the
 * results themselves below the fold.
 */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "left" | "right" | "bottom";
    closeLabel?: string;
  }
>(({ className, children, side = "left", closeLabel = "Close panel", ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn("fixed inset-0 bg-black/70 backdrop-blur-sm z-[var(--z-overlay)]", "dm-fade")}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed border-border bg-card p-5 shadow-lg z-[var(--z-modal)] overflow-y-auto",
        "focus:outline-none",
        side === "left" && "inset-y-0 left-0 w-[min(20rem,85vw)] border-r",
        side === "right" && "inset-y-0 right-0 w-[min(20rem,85vw)] border-l",
        side === "bottom" && "inset-x-0 bottom-0 max-h-[85dvh] border-t",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className={cn(
          "absolute right-3 top-3 inline-flex size-11 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "motion-reduce:transition-none",
        )}
      >
        <X className="size-4" aria-hidden="true" />
        <span className="sr-only">{closeLabel}</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";

export const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("mb-4 pr-10 text-base font-semibold tracking-tight", className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

export const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("mb-4 text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

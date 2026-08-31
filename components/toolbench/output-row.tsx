"use client";

import type * as React from "react";

import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/**
 * One computed value: what it is, what it says, and a way to get it into your notes.
 *
 * The value is monospace on purpose. `docs/frontend/HANDOFF-shell.md` section 13 flags that
 * nobody has yet checked IBM Plex Mono's slashed zero and its 1/l/I at 13px — this component
 * is one of the first places in the product to render a hash and a grid reference at that
 * size, so that check now has somewhere concrete to happen.
 */
export function OutputRow({
  label,
  value,
  hint,
  note,
  copyLabel,
  tone = "default",
}: {
  label: string;
  value: string;
  /** Short qualifier shown next to the label, e.g. "1 m precision". */
  hint?: string;
  /** A sentence under the value, for a caveat the reader needs at the point of reading. */
  note?: React.ReactNode;
  copyLabel?: string;
  tone?: "default" | "warning" | "muted";
}) {
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {hint !== undefined ? (
          <span className="text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <code
          className={cn(
            "min-w-0 flex-1 break-all font-mono text-sm",
            tone === "warning" && "text-warning",
            tone === "muted" && "text-muted-foreground",
          )}
        >
          {value}
        </code>
        <CopyButton value={value} label={copyLabel ?? label} />
      </div>
      {note !== undefined ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{note}</p>
      ) : null}
    </div>
  );
}

/** A card the tool's inputs and outputs sit in, so every tool has the same shape. */
export function ToolPanel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-5", className)}>
      <h3 className="font-semibold leading-tight tracking-tight">{title}</h3>
      {description !== undefined ? (
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </div>
  );
}

/** Inline error for one field. `role="alert"` because it is a response to an action. */
export function FieldError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-2 text-sm leading-relaxed text-destructive">
      {children}
    </p>
  );
}

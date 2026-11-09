"use client";

import * as React from "react";
import { AlertTriangle, Clock, Loader2, PowerOff, Search, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  describeDegraded,
  envelopeAgeSeconds,
  formatAge,
  type LookupOutcome,
} from "@/lib/toolbench/connector-envelope";
import { cn } from "@/lib/utils";
import { useAnnounce } from "./announcer";
import { FieldError } from "./output-row";

/**
 * Shared pieces for server-side Toolbench tools: the query field, the outcome states and
 * the provenance line.
 *
 * Failures are distinguished: input rejected, source switched off, a limit hit (ours or
 * theirs), or the source didn't answer (which is not the same as "nothing found"). Results
 * show their age, recomputed from `fetchedAt`.
 */

/* ------------------------------------------------------------------ *
 * The query field
 * ------------------------------------------------------------------ */

export function LookupForm({
  id,
  label,
  hint,
  placeholder,
  value,
  onValueChange,
  onSubmit,
  pending,
  error,
  submitLabel = "Look up",
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  placeholder: string;
  value: string;
  onValueChange: (next: string) => void;
  onSubmit: () => void;
  pending: boolean;
  error: string | null;
  submitLabel?: string;
  /** Extra controls that belong beside the field, e.g. a filter toggle. */
  children?: React.ReactNode;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) onSubmit();
      }}
      noValidate
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            className="mt-1.5 h-11 font-mono"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={placeholder}
            aria-invalid={error !== null}
            aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          />
        </div>
        <Button type="submit" size="lg" disabled={pending || value.trim().length === 0}>
          {pending ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            <Search className="size-4" aria-hidden="true" />
          )}
          {pending ? "Looking up…" : submitLabel}
        </Button>
      </div>
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children}
      {error !== null ? <FieldError>{error}</FieldError> : null}
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * The four outcomes
 * ------------------------------------------------------------------ */

/**
 * Failure states. Copy comes from `describeDegraded` (`lib/toolbench/connector-envelope.ts`),
 * shared with the other tools. `bad-request` gets its own icon since it's about the reader's
 * input, not the source.
 */
export function LookupStatus({ outcome }: { outcome: LookupOutcome<unknown> | null }) {
  const announce = useAnnounce();

  React.useEffect(() => {
    if (outcome === null || outcome.status === "ok") return;
    const { title } = describeDegraded(outcome.reason);
    announce(
      outcome.reason === "bad-request"
        ? `That input was not accepted. ${outcome.message}`
        : `${title}. No results.`,
    );
  }, [outcome, announce]);

  if (outcome === null || outcome.status === "ok") return null;

  const copy = describeDegraded(outcome.reason);
  const ourFault = outcome.reason === "bad-request";
  const Icon = ourFault ? ShieldAlert : outcome.reason === "disabled" ? PowerOff : AlertTriangle;

  return (
    <Alert
      variant={outcome.reason === "upstream-down" ? "destructive" : "warning"}
      className="mt-6"
    >
      <Icon aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{outcome.message}</p>
        <p className="mt-2">{copy.detail}</p>
        {!copy.retryable ? (
          <p className="mt-2">
            Retrying now would not help, and on a rate limit it would mean asking a service
            that has already said no.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

/** When the answer was obtained, its current age (recomputed on an interval), and its source. */
export function Provenance({
  outcome,
  className,
}: {
  outcome: Extract<LookupOutcome<unknown>, { status: "ok" }>;
  className?: string;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = envelopeAgeSeconds(outcome.fetchedAt, new Date(now)) ?? 0;

  return (
    <div className={cn("mt-4 border-t border-border pt-3 text-xs text-muted-foreground", className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Retrieved <time dateTime={outcome.fetchedAt}>{formatAge(seconds)}</time>, at{" "}
          <span className="font-mono">{outcome.fetchedAt}</span>.
        </span>
      </p>
      {outcome.attribution !== null ? (
        <p className="mt-1.5">{outcome.attribution}</p>
      ) : null}
      {outcome.stale ? (
        <p className="mt-1.5 text-warning">
          This is a cached answer past its refresh time, shown because the source could not be
          reached to renew it.
          {outcome.note === null ? null : ` ${outcome.note}`}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small shared pieces
 * ------------------------------------------------------------------ */

/** A result panel that says nothing found, as a finding rather than as a blank. */
export function EmptyResult({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-5">
      <p className="font-medium text-foreground">{title}</p>
      <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

/** An ISO instant as a plain UTC date (no locale formatting or relative age), so it can be cited. */
export function IsoDate({ value, withTime = false }: { value: string | null; withTime?: boolean }) {
  if (value === null) return <span className="text-muted-foreground">unknown</span>;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return <span className="text-muted-foreground">unknown</span>;
  const iso = parsed.toISOString();
  return (
    <time dateTime={iso} className="font-mono">
      {withTime ? iso.replace("T", " ").replace(".000Z", "Z") : iso.slice(0, 10)}
    </time>
  );
}

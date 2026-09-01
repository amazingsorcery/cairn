"use client";

import * as React from "react";
import { AlertTriangle, Clock, Loader2, PowerOff, Search, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ageSeconds,
  describeAge,
  type LookupOutcome,
} from "@/lib/toolbench/lookup";
import { cn } from "@/lib/utils";
import { useAnnounce } from "./announcer";
import { FieldError } from "./output-row";

/**
 * The parts every server-side Toolbench tool shares: the query field, the four honest
 * outcome states, and the provenance line.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER A SPINNER THAT LIES
 * ─────────────────────────────────────────────────────────────────────────────
 * These four tools call a third party, and third parties are down, slow, and sometimes
 * refuse us. The interface has to distinguish, in words the reader can act on:
 *
 *   - **We refused your input**, and here is what to change. Nothing was requested.
 *   - **An operator switched this source off.** Nothing was requested. Not a fault.
 *   - **You, or everyone, hit a limit.** Ours, or theirs. Different sentences, because the
 *     first clears on a timer and the second means we have stood down.
 *   - **The source did not answer.** Which is emphatically not "there is nothing to find" —
 *     for this audience that confusion turns a failed lookup into a published claim.
 *
 * And an answer always carries the instant it was obtained, computed from `fetchedAt` on
 * every render rather than baked in at response time (ADR 0014 §1).
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

/** Copy for each failure, written so a reader knows whether to retry, wait, or stop. */
const FAILURE_COPY: Readonly<
  Record<
    "disabled" | "quota-exhausted" | "rate-limited" | "upstream-down",
    { title: string; guidance: string }
  >
> = {
  disabled: {
    title: "This source is switched off",
    guidance:
      "No request was made. An operator turns each source on deliberately after reviewing the terms we recorded for it, so this is a decision rather than a fault. Everything else on this page — the technique, its limits and the worked example — still applies.",
  },
  "quota-exhausted": {
    title: "This tool has reached its own limit",
    guidance:
      "This is our ceiling, not the source's, and nothing left this server. We cap our own traffic so that a burst from here never becomes a burden on a free public service. It clears within a minute.",
  },
  "rate-limited": {
    title: "The source asked us to slow down",
    guidance:
      "This one is theirs, not ours, and it is the only failure here where retrying would be wrong rather than merely useless. We have stopped calling until the cooldown expires.",
  },
  "upstream-down": {
    title: "The source did not answer",
    guidance:
      "This is not a result. It says nothing at all about what you looked up — do not record it as an absence of data. Try again in a few minutes, and if it persists, check the source directly before drawing any conclusion.",
  },
};

export function LookupStatus({ outcome }: { outcome: LookupOutcome<unknown> | null }) {
  const announce = useAnnounce();

  React.useEffect(() => {
    if (outcome === null) return;
    if (outcome.status === "invalid") announce(`That input was not accepted. ${outcome.message}`);
    else if (outcome.status === "unavailable") {
      announce(`${FAILURE_COPY[outcome.reason].title}. No results.`);
    }
  }, [outcome, announce]);

  if (outcome === null || outcome.status === "ok") return null;

  if (outcome.status === "invalid") {
    return (
      <Alert variant="warning" className="mt-6">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>That is not something this tool can look up</AlertTitle>
        <AlertDescription>
          <p>{outcome.message}</p>
          <p className="mt-2">
            Nothing was sent anywhere. The check runs before any request is made.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  const copy = FAILURE_COPY[outcome.reason];
  return (
    <Alert variant={outcome.reason === "upstream-down" ? "destructive" : "warning"} className="mt-6">
      {outcome.reason === "disabled" ? (
        <PowerOff aria-hidden="true" />
      ) : (
        <AlertTriangle aria-hidden="true" />
      )}
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{outcome.message}</p>
        <p className="mt-2">{copy.guidance}</p>
      </AlertDescription>
    </Alert>
  );
}

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

/**
 * When the answer was obtained, how old it is now, and who it came from.
 *
 * The age ticks. `fetchedAt` is the instant the upstream answered, and the age is recomputed
 * from it on an interval rather than being computed once on the server — a number baked in
 * at response time is wrong the moment the response is a second old, and on a page whose
 * whole value is provenance that is the one number that must never lie.
 */
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

  const seconds = ageSeconds(outcome.fetchedAt, now);

  return (
    <div className={cn("mt-4 border-t border-border pt-3 text-xs text-muted-foreground", className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Retrieved <time dateTime={outcome.fetchedAt}>{describeAge(seconds)}</time>, at{" "}
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

/**
 * Render an ISO instant as a plain UTC date, never a locale string and never a relative age.
 *
 * `docs/frontend/HANDOFF-toolbench.md` §2: the Toolbench renders instants, not editorial
 * dates. Every timestamp on these four pages is an evidentiary fact that goes into somebody's
 * notes, and "3 months ago" is not a fact you can cite.
 */
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

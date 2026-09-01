import { z } from "zod";

import { fail, ok, type ToolResult } from "./result";

/**
 * The envelope a Toolbench route handler returns, and the sentence a reader gets for each
 * way it can be degraded.
 *
 * Two tools here send a query through `lib/connectors/` — the Overpass builder and the
 * broadcast finder — and both need the same thing: a client-side parse of the response that
 * cannot throw, and copy that distinguishes the four degraded states ADR 0011 rule 5 names.
 * "Something went wrong" is not one of them.
 *
 * The distinctions are not pedantry. `quota-exhausted` means we refused the caller against a
 * ceiling we chose, and waiting will fix it. `rate-limited` means the upstream refused us,
 * and the correct behaviour is to stop asking. `disabled` means an operator turned it off,
 * which is a decision and not a fault. A reader who is told the wrong one retries the wrong
 * thing.
 */

export const DEGRADED_REASONS = [
  "upstream-down",
  "stale",
  "quota-exhausted",
  "rate-limited",
  "disabled",
] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export const CONNECTOR_STATES = ["fresh", "stale", "unavailable"] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

/**
 * The wire shape. `data` is left as `unknown` here and validated by each tool's own schema:
 * this module knows about the envelope, not about what is inside it.
 */
export const connectorEnvelopeSchema = z.object({
  state: z.enum(CONNECTOR_STATES),
  fetchedAt: z.string().nullable(),
  data: z.unknown(),
  attribution: z.string().nullable(),
  reason: z.enum(DEGRADED_REASONS).nullable(),
  message: z.string().nullable(),
  connector: z.string(),
});

export type ConnectorEnvelopeDto = z.infer<typeof connectorEnvelopeSchema>;

export function parseEnvelope(raw: unknown): ToolResult<ConnectorEnvelopeDto> {
  const parsed = connectorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "This site's own endpoint answered with something unexpected. That is a fault here, not at the source.",
    );
  }
  return ok(parsed.data);
}

export interface DegradedCopy {
  /** A heading, four words or so. */
  readonly title: string;
  /** What is actually wrong and what to do about it. */
  readonly detail: string;
  /**
   * Whether trying the same thing again could plausibly work. False for `rate-limited` and
   * `disabled`, so the UI can disable the button instead of inviting a reader to hammer an
   * upstream that has already refused us.
   */
  readonly retryable: boolean;
}

const DEGRADED_COPY: Readonly<Record<DegradedReason, DegradedCopy>> = {
  "upstream-down": {
    title: "The source did not answer",
    detail:
      "The upstream service could not be reached or did not respond in time. Nothing is wrong with your query. Try again in a minute.",
    retryable: true,
  },
  stale: {
    title: "Showing the last answer we have",
    detail:
      "The source is not responding right now, so this is a cached result from an earlier request. Its age is shown next to it.",
    retryable: true,
  },
  "quota-exhausted": {
    title: "This tool has reached its own limit",
    detail:
      "A ceiling we set has been reached — either yours or the one shared across everyone using this site. It is deliberately well below what the upstream tolerates. Wait a minute and try again.",
    retryable: true,
  },
  "rate-limited": {
    title: "The source asked us to slow down",
    detail:
      "The upstream refused the request and we have stopped calling it until the cooldown expires. Retrying now would be asking a service that has already said no, so the button is disabled until then.",
    retryable: false,
  },
  disabled: {
    title: "This source is switched off",
    detail:
      "An operator has not enabled this connector, or it has no recorded legal basis on file. No request was made. This is a decision rather than a fault, and everything on this page that runs in your browser still works.",
    retryable: false,
  },
};

export function describeDegraded(reason: DegradedReason): DegradedCopy {
  return DEGRADED_COPY[reason];
}

/** Seconds since the payload was fetched, or null when nothing was ever fetched. */
export function envelopeAgeSeconds(fetchedAt: string | null, now: Date = new Date()): number | null {
  if (fetchedAt === null) return null;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((now.getTime() - at) / 1000));
}

/** "just now", "40 seconds ago", "4 minutes ago". Never a bare locale string. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return "never fetched";
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

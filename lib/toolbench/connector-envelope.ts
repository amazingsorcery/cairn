import { z } from "zod";

import { fail, ok, type ToolResult } from "./result";

/**
 * The one vocabulary the Toolbench uses for a connector-backed answer, in both directions it
 * can arrive: parsed off the wire from a Route Handler, or returned directly from a Server
 * Action.
 *
 * MERGED FROM TWO MODULES. `lib/toolbench/lookup.ts` and this file were written the same day
 * by two agents solving the same problem for two transports, and expressed the same six
 * states with the same reasoning in two vocabularies. Two names for one concept is how a
 * surface ends up rendering "something went wrong" because the copy lived in the other one.
 *
 * Both transports are still supported and neither is a compatibility shim:
 *
 *   - **Route Handlers** (`/toolbench/overpass`, the broadcast finder) return JSON, so the
 *     response is `unknown` and has to be parsed: `connectorEnvelopeSchema` + `parseEnvelope`.
 *   - **Server Actions** (the four network tools) are typed end to end, so there is nothing
 *     to parse and the payload keeps its type: `LookupOutcome<T>`.
 *
 * Underneath both sits ONE reason vocabulary and ONE copy table, so a reader gets the same
 * sentence for the same condition whichever tool they are on.
 *
 * The distinctions are not pedantry. `quota-exhausted` means we refused the caller against a
 * ceiling we chose, and waiting will fix it. `rate-limited` means the upstream refused us,
 * and the correct behaviour is to stop asking. `disabled` means an operator turned it off,
 * which is a decision and not a fault. `bad-request` means we rejected what was typed and
 * called nobody. A reader who is told the wrong one retries the wrong thing.
 */

/**
 * Mirrors `DegradedReason` in `lib/connectors/types.ts`, value for value.
 *
 * Deliberately duplicated rather than imported, for one reason: `lib/connectors/` throws on
 * load in a browser bundle by design, and these values are needed by Client Components. The
 * duplication is not left to memory — `connector-envelope.test.ts` asserts the two lists are
 * identical, so adding a seventh reason on the server and forgetting it here fails a test
 * rather than silently rendering a blank panel for a state that now exists.
 */
export const DEGRADED_REASONS = [
  "upstream-down",
  "stale",
  "quota-exhausted",
  "rate-limited",
  "disabled",
  "bad-request",
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
      "The upstream could not be reached, did not respond in time, or answered something unusable. Nothing is wrong with your query. THIS IS NOT A RESULT: it says nothing at all about what you looked up, so do not record it as an absence of data. Try again in a minute, and if it persists check the source directly before drawing any conclusion.",
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
  "bad-request": {
    title: "That input was not accepted",
    detail:
      "We rejected the query before calling anyone, so nothing was sent anywhere. The message above says what to change. This is a fault in the input rather than in the source.",
    retryable: true,
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


/* ------------------------------------------------------------------ *
 * The Server Action shape
 * ------------------------------------------------------------------ */

/**
 * What a server-side Toolbench lookup returns to the browser when the transport is a Server
 * Action rather than a Route Handler.
 *
 * TWO OUTCOMES, NOT MORE. A Server Action is typed end to end, so on success the payload
 * keeps its type and there is nothing to parse; on failure there is exactly one thing the UI
 * needs, which is the `reason`. An earlier version of this union carried a third `invalid`
 * member for a refused input — that is now `unavailable` with `reason: "bad-request"`, which
 * is one fewer concept and uses the same vocabulary as every other surface.
 *
 * There is no pending state in this union, on purpose: pending is the client's business and
 * belongs to `useTransition`, not to a value the server returns.
 */
export type LookupOutcome<T> =
  | {
      readonly status: "ok";
      readonly data: T;
      /** ISO 8601. The instant the upstream answered, not the instant we rendered. */
      readonly fetchedAt: string;
      /** True when this is a cached payload past its TTL, served because a refresh failed. */
      readonly stale: boolean;
      /** Rendered next to the data, never in a footer. Null only when none is owed. */
      readonly attribution: string | null;
      /** Present on a stale answer: one sentence saying why it was not refreshed. */
      readonly note: string | null;
    }
  | {
      readonly status: "unavailable";
      readonly reason: DegradedReason;
      /** One sentence, safe to render verbatim. Never an upstream body, a stack or a URL. */
      readonly message: string;
      readonly attribution: string | null;
    };

/**
 * Did anything actually leave our server?
 *
 * Worth having as a function rather than a comment: three of the six reasons mean we refused
 * before calling anyone, and a page that says "the source is unavailable" when no source was
 * contacted is telling the reader something false about a third party.
 */
export function madeARequest(outcome: LookupOutcome<unknown>): boolean {
  if (outcome.status === "ok") return true;
  return (
    outcome.reason !== "disabled" &&
    outcome.reason !== "quota-exhausted" &&
    outcome.reason !== "bad-request"
  );
}

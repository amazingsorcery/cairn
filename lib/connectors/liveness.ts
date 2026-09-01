import type { Connector } from "@/db/schema";

/**
 * Whether a connector may call its upstream **right now**. One definition, imported by every
 * governed path.
 *
 * This file exists because the predicate was previously written twice and then, briefly, not
 * at all on one of the two paths. `lib/queries/live.ts`'s `getLiveConnector` applied these
 * four conditions inside its SQL; a refactor replaced it with `getConnectorBySlug`, which is
 * documented as returning a row *regardless of state*, and the wrapper that re-applied the
 * checks was deleted in the same commit as redundant. The filter was known and simply not
 * carried across.
 *
 * The result was that all thirteen connectors sat `enabled = false, status = 'draft'` in the
 * database and called their upstreams anyway, on anonymous requests — including two whose own
 * recorded legal basis says an operator must decide deliberately before enabling them.
 *
 * So: one predicate, one file, imported. Not re-expressed, not re-derived, not inlined into a
 * query. A control that is specified, documented and argued for at length, and then not wired
 * to the thing it guards, is the failure this whole module exists to prevent.
 */
/*
 * Returns a plain boolean, deliberately NOT a `connector is Connector` type predicate.
 *
 * A predicate would narrow the *false* branch to `null`, which is wrong: a row that exists
 * but is disabled, draft, or missing its recorded basis is still a `Connector`, and the
 * refusal path needs its id to audit the refusal. Modelling "not live" as "absent" is how the
 * distinction between "we chose not to call them" and "there is nobody to call" gets lost.
 */
export function isLive(connector: Connector | null): boolean {
  if (!connector) return false;
  return (
    connector.enabled &&
    connector.status === "published" &&
    connector.termsUrl !== null &&
    connector.legalBasis !== null
  );
}

/**
 * Why a row is not live, in one sentence fit to render to a reader. Never speculative — each
 * branch states the one condition that actually failed, because "unavailable" tells an
 * operator nothing they can act on at three in the morning.
 */
export function notLiveReason(connector: Connector | null, slug: string): string {
  if (!connector) return `${slug} has no registry row, so there is no recorded basis to call it`;
  if (!connector.enabled) return "an operator switched this source off";
  if (connector.status !== "published") return `this source is ${connector.status}, not published`;
  return "this source has no recorded terms or legal basis";
}

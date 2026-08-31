import type { SourceFeature } from "@/lib/sources/types";
import type { MapLayerDefinition, SortDirection, TableSort } from "./registry";

/**
 * Sorting for the accessible table. Pure, so it can be tested without a DOM.
 *
 * ## Nulls always sort last, in both directions
 *
 * Carried over from `components/live/flights-table.tsx`, where it was worked out for
 * aircraft that broadcast no callsign. An earthquake with no reported depth is not "shallower
 * than everything" or "deeper than everything" — it is an absence, and floating absences to
 * the top of a descending sort buries the data the reader asked to see under the rows that
 * have none of it.
 *
 * ## The tiebreak is the feature id
 *
 * `SourceFeature.id` is stable within a source across polls, which is what the contract
 * promises it for. Without a tiebreak, equal values reshuffle on every refresh and a reader
 * comparing two rows watches them swap under the cursor.
 */

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "en");
}

export function sortFeatures<F extends SourceFeature>(
  features: readonly F[],
  layer: MapLayerDefinition<F>,
  sort: TableSort,
): F[] {
  const column = layer.columns.find((c) => c.key === sort.key) ?? layer.columns[0];
  if (!column) return [...features];

  return [...features].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);

    /*
     * NULLS ARE RESOLVED BEFORE THE DIRECTION IS APPLIED, and this ordering is the whole
     * rule. Folding them into the comparator and then negating it for a descending sort
     * negates the null result too — absences float to the TOP of one direction, which is
     * precisely the behaviour the rule exists to prevent. The first version of this function
     * had that bug and `sort.test.ts` caught it.
     */
    if (left === null && right === null) return a.id.localeCompare(b.id, "en");
    if (left === null) return 1;
    if (right === null) return -1;

    const result = compareValues(left, right);
    if (result !== 0) return sort.direction === "asc" ? result : -result;
    /*
     * The tiebreak is NOT reversed with the direction either. Reversing it would make the
     * two directions produce different orders for equal values, which reads as the table
     * reshuffling rows it was not asked to move.
     */
    return a.id.localeCompare(b.id, "en");
  });
}

/**
 * What activating a column header does.
 *
 * A new column starts in the direction the registry declared for it — descending for a
 * magnitude, ascending for a place name — because "sort by magnitude" almost always means
 * "show me the big ones". Re-activating the current column reverses it.
 */
export function nextSort(
  current: TableSort,
  key: string,
  initialDirection: SortDirection | undefined,
): TableSort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: initialDirection ?? "asc" };
}

export const ARIA_SORT: Record<SortDirection, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

/** The sentence the surface announces in its one polite live region after a sort change. */
export function sortDescription(layer: MapLayerDefinition, sort: TableSort): string {
  const column = layer.columns.find((c) => c.key === sort.key);
  return `${layer.label} sorted by ${column?.label ?? sort.key}, ${ARIA_SORT[sort.direction]}.`;
}

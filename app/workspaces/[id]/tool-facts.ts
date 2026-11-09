import type { ToolFacts } from "@/components/workspaces/tool-facts-types";
import type { WorkspaceItemView } from "@/lib/queries/workspaces";

/**
 * Confidence and last-verified date for a case's saved tools, keyed by slug. No queries:
 * both are joined onto the item rows in `getWorkspace` (avoids an N+1 per tool).
 *
 * A deleted or unpublished tool has a null `toolSlug` and yields no entry, so the caller
 * renders the "no longer in the catalogue" state.
 */
export function toolFactsFor(items: readonly WorkspaceItemView[]): Record<string, ToolFacts> {
  const facts: Record<string, ToolFacts> = {};

  for (const item of items) {
    // Both are null together (same `case when` in the query), but the compiler can't know.
    if (item.toolSlug === null || item.toolConfidence === null) continue;
    facts[item.toolSlug] = {
      confidence: item.toolConfidence,
      lastVerifiedAt: item.toolLastVerifiedAt,
    };
  }

  return facts;
}

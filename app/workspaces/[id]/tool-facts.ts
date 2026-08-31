import type { ToolFacts } from "@/components/workspaces/tool-facts-types";
import type { WorkspaceItemView } from "@/lib/queries/workspaces";

/**
 * Current confidence and last-verified date for the tools a case has saved, keyed by slug.
 *
 * NO QUERIES. Both facts now arrive on the item rows themselves, joined in
 * `getWorkspace` — architecture HANDOFF §9.1 requires them wherever an entry appears, and
 * they are on the row the page already has.
 *
 * WHAT THIS REPLACED, and why (QA finding Q-15). This used to be
 * `Promise.all(unique.map(getToolBySlug))` — one cached read per saved tool. A warm cache
 * collapsed it to nothing, which is why it looked fine; a cold cache, a deploy, or any
 * editorial publish firing `revalidateTag('tools')` restored the full fan-out. After the
 * tool read was split for the partial states it was TWO round trips per tool, so a
 * thirty-tool case was sixty concurrent statements against a pool sized for a 2 GB box.
 * It was the one N+1 left in the read path.
 *
 * The previous version noted the correct fix in its own comment and did not apply it because
 * `lib/` belonged to another engineer. The join is now in `lib/queries/workspaces.ts`.
 *
 * A tool that was deleted or unpublished has a null `toolSlug` and yields no entry, so the
 * caller renders the "no longer in the catalogue" state (ADR 0008). Unchanged behaviour: the
 * case is the user's, the chip is ours, and losing the chip must never cost them the case.
 */
export function toolFactsFor(items: readonly WorkspaceItemView[]): Record<string, ToolFacts> {
  const facts: Record<string, ToolFacts> = {};

  for (const item of items) {
    // `toolConfidence` is non-null exactly when `toolSlug` is — both come from the same
    // `case when t.status = 'published'` in the items query — but the compiler cannot know
    // that, and asserting it would be the kind of claim that stops being true after an edit.
    if (item.toolSlug === null || item.toolConfidence === null) continue;
    facts[item.toolSlug] = {
      confidence: item.toolConfidence,
      lastVerifiedAt: item.toolLastVerifiedAt,
    };
  }

  return facts;
}

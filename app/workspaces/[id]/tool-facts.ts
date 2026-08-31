import type { ToolFacts } from "@/components/workspaces/tool-facts-types";
import { getToolBySlug } from "@/lib/queries/tools";

/**
 * Current confidence and last-verified date for the tools a case has saved.
 *
 * WHY THIS EXISTS RATHER THAN COMING OUT OF `getWorkspace`. `lib/queries/workspaces.ts`
 * returns `tool_slug` for an entry that still resolves but not the entry's `confidence` or
 * `lastVerifiedAt`, and architecture HANDOFF 9.1 requires both wherever an entry appears —
 * the workspace page and the export are named explicitly. Adding the two columns to the
 * items query would be one join and strictly better; `lib/` is another engineer's file, so
 * this composes the existing public read instead and the change is written up in
 * `docs/frontend/HANDOFF-workspaces.md` 7.
 *
 * `getToolBySlug` is `unstable_cache`d by slug and tagged `tools` / `tool:<slug>`. It takes
 * no `userId` and returns nothing private, so reading it here does not put case data into a
 * shared cache — the rule in `caching.md` 6 is about queries whose RESULT depends on the
 * session, and this one's does not.
 *
 * A slug that no longer resolves yields no entry in the map, and the caller renders the
 * "no longer in the catalogue" state (ADR 0008). A failure to read the catalogue must never
 * take the case page down with it: the case is the user's, the chip is ours.
 */
export async function loadToolFacts(slugs: readonly string[]): Promise<Record<string, ToolFacts>> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return {};

  const entries = await Promise.all(
    unique.map(async (slug): Promise<[string, ToolFacts] | null> => {
      try {
        const tool = await getToolBySlug(slug);
        if (!tool) return null;
        return [slug, { confidence: tool.confidence, lastVerifiedAt: tool.lastVerifiedAt }];
      } catch {
        // Degrade to the snapshot-only row rather than failing the whole case file.
        return null;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry): entry is [string, ToolFacts] => entry !== null));
}

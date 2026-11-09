import type { ConfidenceLevel } from "@/db/schema";

/**
 * Catalogue facts shown wherever an entry appears, including inside a case and an export.
 *
 * Kept separate from `WorkspaceItemView`: an item's `title` is a snapshot taken when it was
 * saved, while these are read live so a case shows the current values.
 *
 * Type-only so client and server code can both import it.
 */
export interface ToolFacts {
  confidence: ConfidenceLevel;
  lastVerifiedAt: Date | null;
}

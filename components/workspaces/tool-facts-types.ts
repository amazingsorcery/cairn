import type { ConfidenceLevel } from "@/db/schema";

/**
 * The two catalogue facts that must render wherever an entry appears — including inside a
 * case and inside an export (architecture HANDOFF 9.1, ADR 0007).
 *
 * They are a separate type from `WorkspaceItemView` on purpose. A workspace item's `title`
 * is a SNAPSHOT, frozen at the moment it was saved (ADR 0008); confidence and
 * `lastVerifiedAt` are the opposite — they are the catalogue's current opinion, read live,
 * and a case must show today's value rather than the one that was true when the tool was
 * saved. Mixing them into one row type would invite exactly that bug.
 *
 * A type-only module so both the client component and the server-side loader can import it
 * without either pulling the other's dependencies across the boundary.
 */
export interface ToolFacts {
  confidence: ConfidenceLevel;
  lastVerifiedAt: Date | null;
}

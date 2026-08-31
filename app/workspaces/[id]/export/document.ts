import type { ToolFacts } from "@/components/workspaces/tool-facts-types";
import { confidenceLabel } from "@/components/confidence-chip";
import { brand } from "@/config/brand";
import type { WorkspaceDetail } from "@/lib/queries/workspaces";
import { slugify } from "@/lib/utils";

/**
 * The case file as an evidence artefact.
 *
 * ONE MODEL, TWO RENDERERS. Markdown and PDF are built from the same `CaseDocument` so they
 * cannot drift: an export that says different things in two formats is worse than having
 * only one format, because somebody will quote whichever one they opened.
 *
 * RULES THAT COME FROM THE ARCHITECTURE, NOT FROM TASTE:
 *
 *  - ISO 8601 THROUGHOUT (ADR 0016 6). The rendered UI uses "14 Aug 2026" because it is
 *    unambiguous across reading orders; an export is quoted, sorted and diffed, so it gets
 *    the machine form. Timestamps carry the `Z`; dates are the calendar date.
 *  - EVERY SAVED TOOL CARRIES ITS `confidence` AND `lastVerifiedAt` (architecture HANDOFF
 *    9.1, `flows.md` 4). An export that drops them lets the product's central caveat fall
 *    out of the artefact the user actually keeps — which is the one copy that outlives the
 *    website.
 *  - THE EXPORT IS STAMPED with the moment it was made, and says it is a snapshot. A file
 *    with no export date is undatable evidence.
 *  - SNAPSHOT TITLES ARE WHAT IS PRINTED (ADR 0008), so an exported case is stable and
 *    reproducible regardless of what the catalogue does afterwards. An entry that has left
 *    the catalogue is recorded as such rather than dropped.
 *  - NO BRAND STRING IS TYPED. It comes from `config/brand.ts` (product-brief 7).
 */

export interface CaseDocumentStep {
  position: number;
  title: string;
  checked: boolean;
  checkedAt: string | null;
  /** Absent once the playbook step is gone, or when the step was never linked to one. */
  stepReference: string | null;
  notes: { at: string; body: string }[];
}

export interface CaseDocumentTool {
  title: string;
  savedAt: string;
  /** Null once the entry has left the catalogue (ADR 0008). */
  path: string | null;
  confidence: string | null;
  lastVerifiedAt: string | null;
}

export interface CaseDocument {
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  exportedAt: string;
  playbook: { title: string; path: string | null } | null;
  steps: CaseDocumentStep[];
  tools: CaseDocumentTool[];
  notes: { at: string; body: string }[];
  counts: { steps: number; checked: number; tools: number; notes: number };
  producedBy: string;
}

function isoTimestamp(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function buildCaseDocument(
  workspace: WorkspaceDetail,
  facts: Readonly<Record<string, ToolFacts>>,
  exportedAt: Date,
): CaseDocument {
  const notesByItem = new Map<string, { at: string; body: string }[]>();
  const caseNotes: { at: string; body: string }[] = [];

  // Newest-first is right on screen; an exported record reads forwards in time.
  const ordered = [...workspace.notes].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  for (const note of ordered) {
    const entry = { at: isoTimestamp(note.createdAt), body: note.body };
    if (note.workspaceItemId) {
      const list = notesByItem.get(note.workspaceItemId) ?? [];
      list.push(entry);
      notesByItem.set(note.workspaceItemId, list);
    } else {
      caseNotes.push(entry);
    }
  }

  const playbookSlug = workspace.playbook?.slug ?? null;

  const steps: CaseDocumentStep[] = workspace.checklist.map((item, index) => ({
    position: index + 1,
    title: item.title,
    checked: item.checked,
    checkedAt: item.checkedAt ? isoTimestamp(item.checkedAt) : null,
    stepReference:
      playbookSlug && item.stepOrderIndex !== null
        ? `/playbooks/${playbookSlug}#step-${item.stepOrderIndex + 1}`
        : null,
    notes: notesByItem.get(item.id) ?? [],
  }));

  const tools: CaseDocumentTool[] = workspace.savedTools.map((item) => {
    const fact = item.toolSlug ? facts[item.toolSlug] : undefined;
    return {
      title: item.title,
      savedAt: isoDate(item.createdAt),
      path: item.toolSlug && fact ? `/tools/${item.toolSlug}` : null,
      confidence: fact ? confidenceLabel(fact.confidence) : null,
      lastVerifiedAt: fact?.lastVerifiedAt ? isoDate(fact.lastVerifiedAt) : null,
    };
  });

  return {
    title: workspace.title,
    status: workspace.status,
    createdAt: isoTimestamp(workspace.createdAt),
    updatedAt: isoTimestamp(workspace.updatedAt),
    exportedAt: isoTimestamp(exportedAt),
    playbook: workspace.playbook
      ? { title: workspace.playbook.title, path: `/playbooks/${workspace.playbook.slug}` }
      : null,
    steps,
    tools,
    notes: caseNotes,
    counts: {
      steps: workspace.checklist.length,
      checked: workspace.checklist.filter((item) => item.checked).length,
      tools: workspace.savedTools.length,
      notes: workspace.notes.length,
    },
    producedBy: brand.name,
  };
}

/** `case-southbank-footage-verification-2026-08-31`. No extension. */
export function exportBasename(document: CaseDocument): string {
  const stem = slugify(document.title) || "case";
  return `case-${stem}-${document.exportedAt.slice(0, 10)}`;
}

/**
 * The line that keeps the artefact honest once it has left the site: what the confidence
 * values mean, and that they were true at export time rather than for ever.
 */
export function provenanceNote(document: CaseDocument): string[] {
  return [
    `Exported from ${document.producedBy} at ${document.exportedAt}.`,
    "Confidence and last-verified describe our record of each catalogue entry at the moment of export, not the quality of the tool itself, and not the contents of this case.",
    "Entries marked as no longer in the catalogue were removed after they were saved. The title recorded here is the one shown when it was saved.",
  ];
}

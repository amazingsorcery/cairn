import type { ToolFacts } from "@/components/workspaces/tool-facts-types";
import { confidenceLabel } from "@/components/confidence-chip";
import { brand } from "@/config/brand";
import type { WorkspaceDetail } from "@/lib/queries/workspaces";
import { asDate, isoDate, isoTimestamp } from "@/components/workspaces/dates";
import { slugify } from "@/lib/utils";

/**
 * Case export model shared by the Markdown and PDF renderers, so they can't drift.
 *
 *  - ISO 8601 dates and timestamps (`Z`) throughout.
 *  - Each saved tool includes `confidence` and `lastVerifiedAt`.
 *  - Stamped with the export time.
 *  - Titles are the saved snapshots; entries removed from the catalogue are marked, not dropped.
 *  - Each map feature carries its attribution, licence and precision note inline (ODbL,
 *    CC BY, TfL terms require the credit).
 *  - `observedAt` (upstream) and `savedAt` (user) are both kept.
 *  - Brand name comes from `config/brand.ts`.
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
  /** Null once the entry has left the catalogue. */
  path: string | null;
  confidence: string | null;
  lastVerifiedAt: string | null;
}

/**
 * A live feature as it was when saved. A pure snapshot: the upstream keeps no history, so
 * there's nothing to re-check.
 */
export interface CaseDocumentFeature {
  title: string;
  /** When the upstream observed it. */
  observedAt: string;
  /** When the user saved it. */
  savedAt: string;
  sourceName: string;
  sourceSlug: string;
  sourceKind: string;
  /** The upstream's own id, so the reader can cite the primary record. */
  featureRef: string;
  /** `38.1042, -122.4013` — four decimals, about 11 m. */
  coordinates: string;
  altitudeMetres: number | null;
  sourceUrl: string | null;
  /** Required by the licence; never empty (the write path refuses blanks). */
  attribution: string;
  licence: string;
  /** The full sentence saying what the coordinate is an approximation OF, or null. */
  precisionNote: string | null;
  /** Adapter details with the upstream's field names kept verbatim, so values can be cited. */
  properties: { key: string; value: string }[];
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
  features: CaseDocumentFeature[];
  notes: { at: string; body: string }[];
  counts: { steps: number; checked: number; tools: number; features: number; notes: number };
  producedBy: string;
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
    (a, b) => asDate(a.createdAt).getTime() - asDate(b.createdAt).getTime(),
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

  const features: CaseDocumentFeature[] = workspace.savedFeatures.map((saved) => ({
    title: saved.title,
    observedAt: isoTimestamp(saved.observedAt),
    savedAt: isoTimestamp(saved.savedAt),
    sourceName: saved.sourceName,
    sourceSlug: saved.sourceSlug,
    sourceKind: saved.sourceKind,
    featureRef: saved.featureRef,
    coordinates: `${saved.latitude.toFixed(4)}, ${saved.longitude.toFixed(4)}`,
    altitudeMetres: saved.altitudeMetres,
    sourceUrl: saved.sourceUrl,
    attribution: saved.attribution,
    licence: saved.licence,
    precisionNote: saved.precision?.note ?? null,
    properties: Object.entries(saved.properties).map(([key, value]) => ({
      key,
      value: value === null ? "not reported" : String(value),
    })),
  }));

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
    features,
    notes: caseNotes,
    counts: {
      steps: workspace.checklist.length,
      checked: workspace.checklist.filter((item) => item.checked).length,
      tools: workspace.savedTools.length,
      features: workspace.savedFeatures.length,
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

/** Footer explaining what the confidence values mean and that they reflect export time. */
export function provenanceNote(document: CaseDocument): string[] {
  return [
    `Exported from ${document.producedBy} at ${document.exportedAt}.`,
    "Confidence and last-verified describe our record of each catalogue entry at the moment of export, not the quality of the tool itself, and not the contents of this case.",
    "Entries marked as no longer in the catalogue were removed after they were saved. The title recorded here is the one shown when it was saved.",
    "Saved map features are snapshots. Each records what its source published at the observation time given beside it, kept because live sources hold no history; none of them has been re-checked since, and none can be. Use each feature under the licence named with it, and keep the credit with it.",
  ];
}

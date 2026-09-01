import type { ToolFacts } from "@/components/workspaces/tool-facts-types";
import { confidenceLabel } from "@/components/confidence-chip";
import { brand } from "@/config/brand";
import type { WorkspaceDetail } from "@/lib/queries/workspaces";
import { asDate, isoDate, isoTimestamp } from "@/components/workspaces/dates";
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
 *  - EVERY SAVED MAP FEATURE CARRIES ITS ATTRIBUTION AND LICENCE, next to the feature and
 *    not in a footer (ADR 0025, ADR 0011 rule 2). ODbL, CC BY and the TfL terms make the
 *    credit a condition of use, and an exported case file rendering a saved feature IS a
 *    display. It also carries `precision` where the coordinate is an approximation: the map
 *    renders that caveat from the live feature and an export never calls the map's renderer,
 *    so if it is not on the snapshot it is gone.
 *  - `observedAt` AND `savedAt` ARE TWO FACTS AND BOTH ARE PRINTED. When the upstream saw the
 *    thing, and when the reader kept it. Collapsing them would be a claim about a moment
 *    taken from the wrong clock.
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

/**
 * One live feature, as it was when the reader saved it.
 *
 * There is no live half to this — no `path`, no confidence, no re-check — because the
 * referent is one observation an upstream published once and has since forgotten (ADR 0025).
 * Everything on here was copied at the click.
 */
export interface CaseDocumentFeature {
  title: string;
  /** When the UPSTREAM observed it. */
  observedAt: string;
  /** When the READER saved it. A different fact; both are printed. */
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
  /** A licence condition, not a courtesy. Never empty: the write path refuses a blank one. */
  attribution: string;
  licence: string;
  /** The full sentence saying what the coordinate is an approximation OF, or null. */
  precisionNote: string | null;
  /**
   * The adapter's own detail, with the UPSTREAM'S OWN FIELD NAMES kept verbatim.
   *
   * Not prettified. A reader quoting this months later needs to be able to match a value back
   * to the field the source published, and "depth km" is a guess at what `depthKm` meant.
   */
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

/**
 * The line that keeps the artefact honest once it has left the site: what the confidence
 * values mean, and that they were true at export time rather than for ever.
 */
export function provenanceNote(document: CaseDocument): string[] {
  return [
    `Exported from ${document.producedBy} at ${document.exportedAt}.`,
    "Confidence and last-verified describe our record of each catalogue entry at the moment of export, not the quality of the tool itself, and not the contents of this case.",
    "Entries marked as no longer in the catalogue were removed after they were saved. The title recorded here is the one shown when it was saved.",
    "Saved map features are snapshots. Each records what its source published at the observation time given beside it, kept because live sources hold no history; none of them has been re-checked since, and none can be. Use each feature under the licence named with it, and keep the credit with it.",
  ];
}

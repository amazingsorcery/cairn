import type { CaseDocument } from "./document";
import { provenanceNote } from "./document";

/**
 * The Markdown export. Returns immediately and needs no progress state
 * (`docs/design/states.md` 7.6).
 *
 * Note bodies are written through UNCHANGED. They are the user's own Markdown, this is
 * their file, and reformatting somebody's evidence notes on the way out would be a small
 * act of vandalism. They are indented under their step only where that costs nothing.
 */
export function renderCaseMarkdown(doc: CaseDocument): string {
  const out: string[] = [];

  out.push(`# ${doc.title}`, "");
  out.push(`- Status: ${doc.status}`);
  out.push(`- Started: ${doc.createdAt}`);
  out.push(`- Last changed: ${doc.updatedAt}`);
  out.push(`- Exported: ${doc.exportedAt}`);
  if (doc.playbook) {
    out.push(
      `- Started from playbook: ${doc.playbook.title}${doc.playbook.path ? ` (${doc.playbook.path})` : ""}`,
    );
  }
  out.push("");

  out.push(`## Checklist — ${doc.counts.checked} of ${doc.counts.steps} done`, "");
  if (doc.steps.length === 0) {
    out.push("_No checklist steps in this case._", "");
  } else {
    for (const step of doc.steps) {
      const box = step.checked ? "x" : " ";
      const reference = step.stepReference ? ` — ${step.stepReference}` : "";
      out.push(`- [${box}] ${step.position}. ${step.title}${reference}`);
      if (step.checked && step.checkedAt) out.push(`  - Ticked: ${step.checkedAt}`);
      if (!step.stepReference) {
        out.push("  - No linked playbook step. The title above is the one saved with this case.");
      }
      for (const note of step.notes) {
        out.push(`  - Note ${note.at}:`);
        for (const line of note.body.split("\n")) out.push(`    ${line}`);
      }
    }
    out.push("");
  }

  out.push(`## Saved tools — ${doc.counts.tools}`, "");
  if (doc.tools.length === 0) {
    out.push("_No tools saved in this case._", "");
  } else {
    for (const tool of doc.tools) {
      out.push(`### ${tool.title}`, "");
      if (tool.path) {
        out.push(`- Entry: ${tool.path}`);
        out.push(`- Confidence: ${tool.confidence ?? "unknown"}`);
        out.push(`- Last verified: ${tool.lastVerifiedAt ?? "never verified"}`);
      } else {
        out.push("- No longer in the catalogue.");
      }
      out.push(`- Saved to this case: ${tool.savedAt}`, "");
    }
  }

  /*
   * SAVED MAP FEATURES. Every one carries its credit and its licence INLINE, beside the
   * feature (ADR 0025, ADR 0011 rule 2) — a line at the foot of the file does not satisfy
   * ODbL, CC BY or the TfL terms, and this file gets pasted into other documents in pieces.
   *
   * Observed and saved are both printed and never collapsed: one is the upstream's instant,
   * the other is ours.
   */
  out.push(`## Saved from the map — ${doc.counts.features}`, "");
  if (doc.features.length === 0) {
    out.push("_No map features saved in this case._", "");
  } else {
    for (const feature of doc.features) {
      out.push(`### ${feature.title}`, "");
      out.push(`- Observed: ${feature.observedAt}`);
      out.push(`- Position: ${feature.coordinates}`);
      if (feature.precisionNote) {
        // The caveat goes UNDER the number it qualifies, in a full sentence. An export never
        // calls the map's renderer, so this is the only place it can be said.
        out.push(`  - Approximate position. ${feature.precisionNote}`);
      }
      if (feature.altitudeMetres !== null) {
        out.push(`- Altitude: ${Math.round(feature.altitudeMetres)} m`);
      }
      out.push(`- Source: ${feature.sourceName} (${feature.sourceSlug}, ${feature.sourceKind})`);
      out.push(`- Source record: ${feature.featureRef}`);
      if (feature.sourceUrl) out.push(`- Origin: ${feature.sourceUrl}`);
      out.push(`- Attribution: ${feature.attribution}`);
      out.push(`- Licence: ${feature.licence}`);
      for (const property of feature.properties) {
        out.push(`- ${property.key}: ${property.value}`);
      }
      out.push(`- Saved to this case: ${feature.savedAt}`, "");
    }
  }

  out.push(`## Notes — ${doc.counts.notes}`, "");
  const anchored = doc.counts.notes - doc.notes.length;
  if (anchored > 0) {
    out.push(
      `_${anchored} ${anchored === 1 ? "note is" : "notes are"} attached to checklist steps above._`,
      "",
    );
  }
  if (doc.notes.length === 0 && anchored === 0) {
    out.push("_No notes in this case._", "");
  }
  for (const note of doc.notes) {
    out.push(`### ${note.at}`, "", note.body, "");
  }

  out.push("---", "");
  for (const line of provenanceNote(doc)) out.push(line, "");

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

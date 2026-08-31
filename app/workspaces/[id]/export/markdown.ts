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

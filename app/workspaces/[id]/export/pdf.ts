import PDFDocument from "pdfkit/js/pdfkit.standalone.js";

import type { CaseDocument } from "./document";
import { provenanceNote } from "./document";

/**
 * PDF export. Uses pdfkit's standalone build (see `pdfkit-standalone.d.ts`) rather than a
 * headless browser, to keep memory and image size down on a small VPS.
 *
 * Built-in Helvetica only, so no font files are needed at run time. Takes the same
 * `CaseDocument` as the Markdown renderer.
 */

const MARGIN = 56;

type Doc = InstanceType<typeof PDFDocument>;

function heading(doc: Doc, text: string, size: number, spaceBefore = 14): void {
  doc.moveDown(spaceBefore / 12);
  doc.font("Helvetica-Bold").fontSize(size).fillColor("#111111").text(text);
  doc.moveDown(0.3);
}

function body(doc: Doc, text: string, options: { indent?: number; muted?: boolean } = {}): void {
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor(options.muted ? "#555555" : "#111111")
    .text(text, { indent: options.indent ?? 0, align: "left" });
}

function mono(doc: Doc, text: string, indent = 0): void {
  doc.font("Courier").fontSize(9).fillColor("#333333").text(text, { indent });
}

export function renderCasePdf(caseDoc: CaseDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      info: {
        Title: caseDoc.title,
        Author: caseDoc.producedBy,
        Subject: `Case file exported ${caseDoc.exportedAt}`,
        CreationDate: new Date(caseDoc.exportedAt),
      },
      autoFirstPage: true,
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#111111").text(caseDoc.title);
      doc.moveDown(0.5);

      mono(doc, `status            ${caseDoc.status}`);
      mono(doc, `started           ${caseDoc.createdAt}`);
      mono(doc, `last changed      ${caseDoc.updatedAt}`);
      mono(doc, `exported          ${caseDoc.exportedAt}`);
      if (caseDoc.playbook) {
        mono(doc, `from playbook     ${caseDoc.playbook.title}`);
        if (caseDoc.playbook.path) mono(doc, `                  ${caseDoc.playbook.path}`);
      }

      heading(doc, `Checklist — ${caseDoc.counts.checked} of ${caseDoc.counts.steps} done`, 13);
      if (caseDoc.steps.length === 0) {
        body(doc, "No checklist steps in this case.", { muted: true });
      } else {
        for (const step of caseDoc.steps) {
          doc
            .font("Helvetica-Bold")
            .fontSize(10)
            .fillColor("#111111")
            .text(`${step.checked ? "[x]" : "[ ]"} ${step.position}. ${step.title}`);
          if (step.checked && step.checkedAt) {
            mono(doc, `ticked ${step.checkedAt}`, 18);
          }
          if (step.stepReference) {
            mono(doc, step.stepReference, 18);
          } else {
            body(doc, "No linked playbook step. The title above is the one saved with this case.", {
              indent: 18,
              muted: true,
            });
          }
          for (const note of step.notes) {
            mono(doc, `note ${note.at}`, 18);
            body(doc, note.body, { indent: 18 });
          }
          doc.moveDown(0.4);
        }
      }

      heading(doc, `Saved tools — ${caseDoc.counts.tools}`, 13);
      if (caseDoc.tools.length === 0) {
        body(doc, "No tools saved in this case.", { muted: true });
      } else {
        for (const tool of caseDoc.tools) {
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#111111").text(tool.title);
          if (tool.path) {
            mono(doc, `entry           ${tool.path}`, 12);
            mono(doc, `confidence      ${tool.confidence ?? "unknown"}`, 12);
            mono(doc, `last verified   ${tool.lastVerifiedAt ?? "never verified"}`, 12);
          } else {
            body(doc, "No longer in the catalogue.", { indent: 12, muted: true });
          }
          mono(doc, `saved           ${tool.savedAt}`, 12);
          doc.moveDown(0.4);
        }
      }

      // Attribution and licence go with each feature, not in a footer (licence terms).
      heading(doc, `Saved from the map — ${caseDoc.counts.features}`, 13);
      if (caseDoc.features.length === 0) {
        body(doc, "No map features saved in this case.", { muted: true });
      } else {
        for (const feature of caseDoc.features) {
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#111111").text(feature.title);
          mono(doc, `observed        ${feature.observedAt}`, 12);
          mono(doc, `position        ${feature.coordinates}`, 12);
          if (feature.precisionNote) {
            body(doc, `Approximate position. ${feature.precisionNote}`, { indent: 12 });
          }
          if (feature.altitudeMetres !== null) {
            mono(doc, `altitude        ${Math.round(feature.altitudeMetres)} m`, 12);
          }
          mono(doc, `source          ${feature.sourceName} (${feature.sourceSlug})`, 12);
          mono(doc, `source record   ${feature.featureRef}`, 12);
          if (feature.sourceUrl) mono(doc, `origin          ${feature.sourceUrl}`, 12);
          mono(doc, `attribution     ${feature.attribution}`, 12);
          mono(doc, `licence         ${feature.licence}`, 12);
          for (const property of feature.properties) {
            mono(doc, `${property.key.padEnd(15).slice(0, 15)} ${property.value}`, 12);
          }
          mono(doc, `saved           ${feature.savedAt}`, 12);
          doc.moveDown(0.4);
        }
      }

      heading(doc, `Notes — ${caseDoc.counts.notes}`, 13);
      const anchored = caseDoc.counts.notes - caseDoc.notes.length;
      if (anchored > 0) {
        body(
          doc,
          `${anchored} ${anchored === 1 ? "note is" : "notes are"} attached to checklist steps above.`,
          { muted: true },
        );
        doc.moveDown(0.3);
      }
      if (caseDoc.notes.length === 0 && anchored === 0) {
        body(doc, "No notes in this case.", { muted: true });
      }
      for (const note of caseDoc.notes) {
        mono(doc, note.at);
        body(doc, note.body);
        doc.moveDown(0.4);
      }

      doc.moveDown(1);
      doc
        .strokeColor("#cccccc")
        .lineWidth(0.5)
        .moveTo(MARGIN, doc.y)
        .lineTo(doc.page.width - MARGIN, doc.y)
        .stroke();
      doc.moveDown(0.6);
      for (const line of provenanceNote(caseDoc)) {
        doc.font("Helvetica").fontSize(8).fillColor("#555555").text(line);
        doc.moveDown(0.2);
      }

      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error("PDF generation failed"));
    }
  });
}

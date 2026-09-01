import { describe, expect, it } from "vitest";

import { brand } from "@/config/brand";
import type { WorkspaceDetail, WorkspaceItemView } from "@/lib/queries/workspaces";
import { buildCaseDocument, exportBasename } from "./document";
import { renderCaseMarkdown } from "./markdown";

/**
 * The export is an evidence artefact. These tests exist because the three properties below
 * are the ones a user relies on months after the website has moved on, and none of them is
 * visible in a screenshot:
 *
 *   1. ISO 8601 everywhere (ADR 0016 6),
 *   2. every saved tool carrying its `confidence` and `lastVerifiedAt` (architecture
 *      HANDOFF 9.1) — an export that drops them lets the product's central caveat fall out
 *      of the copy the user actually keeps,
 *   3. an entry that has left the catalogue being RECORDED as such rather than dropped
 *      (ADR 0008),
 *   4. every saved map feature carrying its attribution, its licence and — where the
 *      coordinate is an approximation — the caveat saying so (ADR 0025). The export never
 *      calls the map's renderer, so an omission here is not a missing line on a page, it is
 *      the caveat ceasing to exist.
 *
 * The regression test at the bottom is for a bug found by running the page, not by reading
 * it: `lib/queries/workspaces.ts` types these timestamps as `Date` and `db.execute` returns
 * strings, so `value.toISOString()` threw in the browser.
 */

/** A case in the shape `getWorkspace` actually returns, strings and all. */
function fixture(overrides: Partial<WorkspaceDetail> = {}): WorkspaceDetail {
  const base: WorkspaceDetail = {
    id: "a161596f-8a61-405f-8f47-331ec8124298",
    title: "Southbank ownership check",
    status: "active",
    createdAt: new Date("2026-08-22T14:02:11.123Z"),
    updatedAt: new Date("2026-08-23T09:41:00.000Z"),
    playbook: { slug: "corporate-ownership-tracing", title: "Corporate Ownership Tracing" },
    checklist: [
      {
        id: "item-1",
        kind: "checklistStep",
        title: "Fix the entity's identity precisely",
        orderIndex: 0,
        checked: true,
        checkedAt: new Date("2026-08-22T14:30:00.000Z"),
        createdAt: new Date("2026-08-22T14:02:11.000Z"),
        toolSlug: null,
        toolConfidence: null,
        toolLastVerifiedAt: null,
        toolId: null,
        stepId: "step-1",
        playbookSlug: "corporate-ownership-tracing",
        stepOrderIndex: 0,
      },
      {
        id: "item-2",
        // The step it came from was deleted: title survives, link goes (ADR 0008).
        kind: "checklistStep",
        title: "Ask the uploader directly",
        orderIndex: 1,
        checked: false,
        checkedAt: null,
        createdAt: new Date("2026-08-22T14:05:00.000Z"),
        toolSlug: null,
        toolConfidence: null,
        toolLastVerifiedAt: null,
        toolId: null,
        stepId: null,
        playbookSlug: null,
        stepOrderIndex: null,
      },
    ],
    savedTools: [
      {
        id: "tool-1",
        kind: "tool",
        title: "Wayback Machine",
        orderIndex: 0,
        checked: false,
        checkedAt: null,
        createdAt: new Date("2026-08-22T14:10:00.000Z"),
        toolSlug: "wayback-machine",
        toolConfidence: "verified",
        toolLastVerifiedAt: new Date("2026-08-20T00:00:00.000Z"),
        toolId: "t1",
        stepId: null,
        playbookSlug: null,
        stepOrderIndex: null,
      },
      {
        id: "tool-2",
        kind: "tool",
        title: "Amnesty YouTube DataViewer",
        orderIndex: 1,
        checked: false,
        checkedAt: null,
        createdAt: new Date("2026-04-02T09:00:00.000Z"),
        toolSlug: null,
        toolConfidence: null,
        toolLastVerifiedAt: null,
        toolId: null,
        stepId: null,
        playbookSlug: null,
        stepOrderIndex: null,
      },
    ],
    savedFeatures: [
      {
        id: "item-5",
        title: "M 4.6 — 12 km SW of Petrolia",
        orderIndex: 0,
        savedAt: new Date("2026-08-23T10:02:00.000Z"),
        sourceSlug: "usgs-earthquakes",
        sourceName: "USGS Earthquake Hazards Program",
        sourceKind: "earthquakes",
        featureRef: "us7000abcd",
        latitude: 40.28417,
        longitude: -124.4235,
        altitudeMetres: null,
        // The upstream's instant, an hour before the reader saved it. Two facts, not one.
        observedAt: new Date("2026-08-23T09:05:12.000Z"),
        sourceUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
        attribution: "USGS Earthquake Hazards Program",
        licence: "public domain (US Government)",
        properties: { magnitude: 4.6, depthKm: 21.3, tsunamiFlagged: false },
        precision: null,
      },
      {
        id: "item-6",
        title: "Flood Warning — Sonoma County",
        orderIndex: 1,
        savedAt: new Date("2026-08-23T10:04:00.000Z"),
        sourceSlug: "nws-alerts",
        sourceName: "National Weather Service",
        sourceKind: "weather",
        featureRef: "urn:oid:2.49.0.1.840.0.abc",
        latitude: 38.5,
        longitude: -122.9,
        altitudeMetres: null,
        observedAt: new Date("2026-08-23T08:00:00.000Z"),
        sourceUrl: null,
        attribution: "National Weather Service",
        licence: "public domain (US Government)",
        properties: { event: "Flood Warning" },
        // The 98.7% case: a UGC zone centroid, possibly tens of km from the weather.
        precision: {
          label: "approx · zone centre",
          note: "This alert names administrative zones rather than a polygon, so the coordinate is the centre of one zone and may be tens of kilometres from the weather.",
          approximateRadiusMetres: 30000,
        },
      },
    ],
    notes: [
      {
        id: "note-1",
        body: "Four copies. Earliest is the Telegram one.",
        createdAt: new Date("2026-08-22T14:02:00.000Z"),
        updatedAt: new Date("2026-08-22T14:02:00.000Z"),
        workspaceItemId: "item-1",
        playbookStepId: null,
      },
      {
        id: "note-2",
        body: "Weather record shows overcast. Footage shows hard shadows. Flag.",
        createdAt: new Date("2026-08-23T09:41:00.000Z"),
        updatedAt: new Date("2026-08-23T09:41:00.000Z"),
        workspaceItemId: null,
        playbookStepId: null,
      },
    ],
  };
  return { ...base, ...overrides };
}

const FACTS = {
  "wayback-machine": {
    confidence: "high" as const,
    lastVerifiedAt: new Date("2026-08-14T00:00:00.000Z"),
  },
};

const EXPORTED_AT = new Date("2026-08-31T06:06:00.000Z");

describe("buildCaseDocument", () => {
  it("stamps the export with the moment it was made", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.exportedAt).toBe("2026-08-31T06:06:00Z");
  });

  it("writes every timestamp as ISO 8601 with whole seconds", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.createdAt).toBe("2026-08-22T14:02:11Z");
    expect(doc.steps[0]?.checkedAt).toBe("2026-08-22T14:30:00Z");
    expect(doc.notes[0]?.at).toBe("2026-08-23T09:41:00Z");
    for (const value of [doc.createdAt, doc.updatedAt, doc.exportedAt]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it("carries confidence and last-verified for every entry that still resolves", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    const live = doc.tools[0];
    expect(live?.confidence).toBe("High");
    expect(live?.lastVerifiedAt).toBe("2026-08-14");
    expect(live?.path).toBe("/tools/wayback-machine");
  });

  it("records an entry that has left the catalogue instead of dropping it", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    const orphan = doc.tools[1];
    expect(orphan?.title).toBe("Amnesty YouTube DataViewer");
    expect(orphan?.path).toBeNull();
    expect(orphan?.confidence).toBeNull();
    expect(orphan?.savedAt).toBe("2026-04-02");
    expect(doc.counts.tools).toBe(2);
  });

  it("keeps a checklist entry whose playbook step is gone, without a link", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.steps[0]?.stepReference).toBe("/playbooks/corporate-ownership-tracing#step-1");
    expect(doc.steps[1]?.title).toBe("Ask the uploader directly");
    expect(doc.steps[1]?.stepReference).toBeNull();
  });

  it("attaches a note to its checklist entry and leaves case-level notes at the top", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.steps[0]?.notes).toHaveLength(1);
    expect(doc.notes).toHaveLength(1);
    expect(doc.counts.notes).toBe(2);
  });


  it("keeps the upstream's observation instant and the save time apart", () => {
    // ADR 0025: `observed_at` is a claim about a moment, and a moment taken from our own
    // clock would be a different claim. Both are printed; neither stands in for the other.
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    const quake = doc.features[0];
    expect(quake?.observedAt).toBe("2026-08-23T09:05:12Z");
    expect(quake?.savedAt).toBe("2026-08-23T10:02:00Z");
  });

  it("carries the attribution and licence of every saved feature", () => {
    // ODbL, CC BY and the TfL terms make the credit a condition of use, and an exported case
    // file rendering a saved feature is a display.
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.features).toHaveLength(2);
    for (const feature of doc.features) {
      expect(feature.attribution.trim()).not.toBe("");
      expect(feature.licence.trim()).not.toBe("");
    }
  });

  it("carries the precision caveat, which nothing else in the export could reconstruct", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.features[0]?.precisionNote).toBeNull();
    expect(doc.features[1]?.precisionNote).toContain("administrative zones");
  });

  it("names the file after the case and the export date", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(exportBasename(doc)).toBe("case-southbank-ownership-check-2026-08-31");
  });

  it("takes the product name from config rather than a literal", () => {
    const doc = buildCaseDocument(fixture(), FACTS, EXPORTED_AT);
    expect(doc.producedBy).toBe(brand.name);
  });

  /**
   * REGRESSION. `listWorkspaces` and `getWorkspace` build their rows with
   * `db.execute(sql\`…\`)`, which returns raw `pg` values: the timestamps are STRINGS at run
   * time even though the declared type is `Date`. The first version of the workspace page
   * called `.toISOString()` on them and threw. See `components/workspaces/dates.ts`.
   */
  it("accepts the timestamp strings the raw-SQL queries actually return", () => {
    const withStrings = fixture();
    const tool = withStrings.savedTools[0];
    const step = withStrings.checklist[0];
    if (!tool || !step) throw new Error("fixture");

    // Exactly what `pg` hands back for a `timestamptz` column. The double assertion is the
    // point of the test: the declared type says `Date` and the value is a string, which is
    // precisely the mismatch this guards against. Narrowing through `unknown` documents
    // that the lie is deliberate here rather than accidental.
    const asAny = {
      ...tool,
      createdAt: "2026-08-22 16:10:00+02",
    } as unknown as WorkspaceItemView;
    const stepAsAny = {
      ...step,
      checkedAt: "2026-08-22 16:30:00+02",
    } as unknown as WorkspaceItemView;

    const doc = buildCaseDocument(
      fixture({ savedTools: [asAny], checklist: [stepAsAny] }),
      FACTS,
      EXPORTED_AT,
    );

    expect(doc.tools[0]?.savedAt).toBe("2026-08-22");
    expect(doc.steps[0]?.checkedAt).toBe("2026-08-22T14:30:00Z");
  });
});

describe("renderCaseMarkdown", () => {
  const markdown = renderCaseMarkdown(buildCaseDocument(fixture(), FACTS, EXPORTED_AT));

  it("opens with the case title and the export stamp", () => {
    expect(markdown).toMatch(/^# Southbank ownership check\n/);
    expect(markdown).toContain("- Exported: 2026-08-31T06:06:00Z");
  });

  it("renders ticked and unticked steps as a task list with the tick time", () => {
    expect(markdown).toContain("- [x] 1. Fix the entity's identity precisely");
    expect(markdown).toContain("  - Ticked: 2026-08-22T14:30:00Z");
    expect(markdown).toContain("- [ ] 2. Ask the uploader directly");
  });

  it("prints confidence and last-verified beside every live entry", () => {
    expect(markdown).toContain("- Confidence: High");
    expect(markdown).toContain("- Last verified: 2026-08-14");
  });

  it("states plainly when an entry has left the catalogue", () => {
    expect(markdown).toContain("### Amnesty YouTube DataViewer");
    expect(markdown).toContain("- No longer in the catalogue.");
  });

  it("keeps the note bodies verbatim", () => {
    expect(markdown).toContain("Four copies. Earliest is the Telegram one.");
    expect(markdown).toContain(
      "Weather record shows overcast. Footage shows hard shadows. Flag.",
    );
  });


  it("prints every saved feature with its credit beside it, not in a footer", () => {
    expect(markdown).toContain("## Saved from the map — 2");
    expect(markdown).toContain("### M 4.6 — 12 km SW of Petrolia");
    expect(markdown).toContain("- Observed: 2026-08-23T09:05:12Z");
    expect(markdown).toContain("- Position: 40.2842, -124.4235");
    expect(markdown).toContain("- Attribution: USGS Earthquake Hazards Program");
    expect(markdown).toContain("- Licence: public domain (US Government)");
    expect(markdown).toContain("- Saved to this case: 2026-08-23T10:02:00Z");
    // The upstream's own field names, verbatim, so a value can be matched back to a source.
    expect(markdown).toContain("- depthKm: 21.3");
  });

  it("states the coordinate caveat under the coordinate it qualifies", () => {
    expect(markdown).toContain("- Position: 38.5000, -122.9000");
    expect(markdown).toContain("  - Approximate position. This alert names administrative zones");
  });

  it("says a saved feature can never be re-checked", () => {
    expect(markdown).toContain("Saved map features are snapshots.");
  });

  it("carries no date in a non-ISO shape", () => {
    // `14 Aug 2026` is the UI rendering and must not reach an export (ADR 0016 6).
    expect(markdown).not.toMatch(/\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/);
  });

  it("says what confidence means, so the artefact is readable off the site", () => {
    expect(markdown).toContain(`Exported from ${brand.name} at 2026-08-31T06:06:00Z.`);
    expect(markdown).toContain("our record of each catalogue entry");
  });
});

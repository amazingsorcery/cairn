import { describe, expect, it } from "vitest";

import { CAMERA_VIEW_KINDS } from "@/db/schema";
import { cameraSubjects } from "@/lib/content/schema";
import {
  CAMERA_SUBJECT_TO_VIEW_KIND,
  assertCameraSubjectsMapped,
} from "@/lib/validation/connectors";
import { checkContiguousOrder } from "@/lib/validation/playbooks";
import { tagNameFromSlug, toOrderIndex, toOrderIndexes, toUtcDate } from "./seed";

/**
 * The seed script's translation rules, tested without a database.
 *
 * These are the parts of `db/seed.ts` that fail SILENTLY when they are wrong: an off-by-one
 * in the step ordering produces a playbook numbered 2..n+1, and a timezone slip moves a
 * verification date across a day boundary. Neither raises.
 */

describe("toOrderIndex — content is 1-based, the column is 0-based", () => {
  it("shifts a 1-based content order to a 0-based index", () => {
    expect(toOrderIndex(1)).toBe(0);
    expect(toOrderIndex(2)).toBe(1);
    expect(toOrderIndex(7)).toBe(6);
  });

  it("refuses 0, which would mean content was already 0-based", () => {
    // If content ever became 0-based, this must fail loudly rather than shift everything to
    // -1 and be rejected later by `playbook_steps_order_index_check` with no explanation.
    expect(() => toOrderIndex(0)).toThrow(/1-based/);
  });

  it("refuses a negative or fractional order", () => {
    expect(() => toOrderIndex(-1)).toThrow(/whole number/);
    expect(() => toOrderIndex(1.5)).toThrow(/whole number/);
  });
});

describe("toOrderIndexes — the whole list, with contiguity asserted on the output", () => {
  it("translates a complete 1..n list to 0..n-1", () => {
    expect(toOrderIndexes([1, 2, 3, 4, 5, 6, 7])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("preserves the authored order, not the sorted order", () => {
    // The array position is what maps to the inserted row, so a list authored out of order
    // must translate positionally and still be contiguous as a set.
    expect(toOrderIndexes([3, 1, 2])).toEqual([2, 0, 1]);
  });

  it("rejects a gap", () => {
    expect(() => toOrderIndexes([1, 2, 4])).toThrow(/contiguous/);
  });

  it("rejects a duplicate", () => {
    expect(() => toOrderIndexes([1, 2, 2])).toThrow(/contiguous/);
  });

  it("rejects a list that does not start at 1", () => {
    expect(() => toOrderIndexes([2, 3, 4])).toThrow(/contiguous/);
  });

  it("agrees with the admin path's contiguity rule", () => {
    // The seed and `replacePlaybookSteps` must enforce the SAME invariant, or content that
    // seeds cleanly cannot be saved from `/admin` and vice versa.
    const translated = toOrderIndexes([1, 2, 3]);
    expect(checkContiguousOrder(translated)).toEqual([]);
  });

  it("handles an empty list", () => {
    expect(toOrderIndexes([])).toEqual([]);
  });
});

describe("toUtcDate", () => {
  it("parses an authored date as midnight UTC", () => {
    // Not local midnight: the container's TZ must not be able to move a verification date
    // across a day boundary (product-brief §6.3).
    expect(toUtcDate("2026-08-31").toISOString()).toBe("2026-08-31T00:00:00.000Z");
  });

  it("round-trips to the same calendar day", () => {
    const date = toUtcDate("2026-01-01");
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(0);
    expect(date.getUTCDate()).toBe(1);
  });

  it("throws on a non-date", () => {
    expect(() => toUtcDate("not-a-date")).toThrow(/calendar date/);
  });
});

describe("tagNameFromSlug", () => {
  it("turns a slug into a readable label", () => {
    expect(tagNameFromSlug("attack-surface")).toBe("Attack surface");
    expect(tagNameFromSlug("tls")).toBe("Tls");
    expect(tagNameFromSlug("iot")).toBe("Iot");
  });

  it("leaves a single word capitalised", () => {
    expect(tagNameFromSlug("certificates")).toBe("Certificates");
  });

  // Acronym casing is deliberately not special-cased: an exception list here would drift
  // from the content and be invisible when it did. An editor renames the tag in
  // /admin/taxonomy, and the rename fans out to search_keywords correctly.
  it("does not attempt to fix acronym casing", () => {
    expect(tagNameFromSlug("osint")).toBe("Osint");
  });
});

describe("camera subject → view kind", () => {
  it("maps every content subject to a schema view kind", () => {
    expect(() => assertCameraSubjectsMapped()).not.toThrow();
    for (const subject of cameraSubjects) {
      expect(CAMERA_VIEW_KINDS).toContain(CAMERA_SUBJECT_TO_VIEW_KIND[subject]);
    }
  });

  it("files road-weather cameras under traffic, not tourism", () => {
    // A road-weather camera is road infrastructure published by a highways authority and
    // read for road conditions. There is no "weather" facet in CAMERA_VIEW_KINDS.
    expect(CAMERA_SUBJECT_TO_VIEW_KIND.weather).toBe("traffic");
  });

  it("files scenic cameras under tourism", () => {
    expect(CAMERA_SUBJECT_TO_VIEW_KIND.scenic).toBe("tourism");
  });

  it("maps the three shared names to themselves", () => {
    expect(CAMERA_SUBJECT_TO_VIEW_KIND.traffic).toBe("traffic");
    expect(CAMERA_SUBJECT_TO_VIEW_KIND.transport).toBe("transport");
    expect(CAMERA_SUBJECT_TO_VIEW_KIND.tourism).toBe("tourism");
  });
});

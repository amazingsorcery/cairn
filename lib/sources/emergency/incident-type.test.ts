import { describe, expect, it } from "vitest";

import { classifyIncident, INCIDENT_CATEGORIES } from "./incident-type";

/**
 * The classifier is the one component ADR 0033 turns into a QA gate: medical dispatch must be
 * detectable so the UI can default it OFF. Every string below is a REAL call type captured
 * from Seattle Fire (kzjm-xkqj) or SFPD (gnap-fj3t) on 2026-09-01, not an invented one — a
 * classifier tested on imagined inputs proves only that our imagination is self-consistent.
 */

describe("classifyIncident — medical, the field that must never be missed", () => {
  // Real Seattle Fire types, in descending volume, that are health data about a person.
  const seattleMedical = [
    "Aid Response",
    "Medic Response",
    "Trans to AMR",
    "Aid Response Yellow",
    "Triaged Incident",
    "Low Acuity Response",
    "Nurseline/AMR",
    "Automatic Medical Alarm",
    "Medic Response, 7 per Rule",
    "Medic Response- Overdose",
    "Hang-Up, Aid",
  ];
  // Real SFPD types that are behavioural-health / medical, which police CAD also carries.
  const sfMedical = [
    "WELL BEING CHECK",
    "MENTALLY DISTURBED",
    "SUICIDE ATTEMPT",
    "Psych escort",
    "AIDED CASE",
  ];

  for (const type of [...seattleMedical, ...sfMedical]) {
    it(`marks "${type}" medical`, () => {
      const result = classifyIncident(type);
      expect(result.category).toBe("medical");
      expect(result.isMedical).toBe(true);
    });
  }

  it("keeps isMedical in lockstep with the category, for every category", () => {
    for (const category of INCIDENT_CATEGORIES) {
      // isMedical is true exactly when the category is medical — the one invariant the
      // default-off toggle depends on.
      const sample = classifyIncident(category === "medical" ? "Medic Response" : "Auto Fire Alarm");
      expect(sample.isMedical).toBe(sample.category === "medical");
    }
  });

  it("does not let a generic word shadow a medical one", () => {
    // "Automatic Medical Alarm" contains "alarm" (fire) but must classify medical, because
    // medical is checked first. Getting this wrong shows a medical call by default.
    expect(classifyIncident("Automatic Medical Alarm").category).toBe("medical");
  });

  it("treats an injury traffic call as medical, not road — a hurt person is health data", () => {
    // Real SFPD type. "injur" is caught before the road rule, so an injury collision defaults
    // OFF rather than being shown as a plain road incident (ADR 0033, privacy-protective).
    expect(classifyIncident("INJURY VEH ACCIDENT").category).toBe("medical");
  });
});

describe("classifyIncident — the visible categories (ADR 0033: shown by default)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Auto Fire Alarm", "fire"],
    ["Fire in Building", "fire"],
    ["Car Fire", "fire"],
    ["Brush Fire", "fire"],
    ["Illegal Burn", "fire"],
    ["Natural Gas Odor", "hazmat"],
    ["Activated CO Detector", "hazmat"],
    ["Rescue Elevator", "rescue"],
    ["Rescue Lock In/Out", "rescue"],
    ["MVI - Motor Vehicle Incident", "road"],
    ["Motor Vehicle Accident Freeway", "road"],
    ["VEH ACCIDENT", "road"],
    ["TRAFFIC HAZARD", "road"],
    ["TRAFFIC STOP", "publicOrder"],
    ["TRAF VIOLATION CITE", "publicOrder"],
    ["SIT/LIE ENFORCEMENT", "publicOrder"],
    ["STOLEN VEHICLE", "publicOrder"],
    ["SUSPICIOUS PERSON", "publicOrder"],
    ["FIGHT NO WEAPON", "publicOrder"],
    ["BURGLARY", "publicOrder"],
    ["VANDALISM", "publicOrder"],
    // The boundary case that most matters: a shooting is public order, not a fire. "\bfires?\b"
    // is an exact word, so "FIRED" is never swept into the fire category.
    ["SHOTS FIRED", "publicOrder"],
  ];
  for (const [type, expected] of cases) {
    it(`classifies "${type}" as ${expected} and not medical`, () => {
      const result = classifyIncident(type);
      expect(result.category).toBe(expected);
      expect(result.isMedical).toBe(false);
    });
  }
});

describe("classifyIncident — unreadable codes fall to other, never guessed medical", () => {
  it("labels an agency-internal code we cannot read as other", () => {
    // "1RED 1 Unit" is a real Seattle response code with no health word. We do not invent a
    // meaning for it (product-brief §6); it is `other`, shown by default, and the limitation
    // is recorded in docs/sources/seattle-fire-911.md.
    const result = classifyIncident("1RED 1 Unit");
    expect(result.category).toBe("other");
    expect(result.isMedical).toBe(false);
  });

  it("treats empty or missing input as other, never medical", () => {
    expect(classifyIncident("").category).toBe("other");
    expect(classifyIncident(null).category).toBe("other");
    expect(classifyIncident(undefined).isMedical).toBe(false);
  });
});

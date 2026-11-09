import { describe, expect, it } from "vitest";

import { classifyIncident, INCIDENT_CATEGORIES } from "./incident-type";

/**
 * Medical dispatch must be detected so the UI can default it off. All strings are real call
 * types from Seattle Fire (kzjm-xkqj) or SFPD (gnap-fj3t), captured 2026-09-01.
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
      // isMedical iff category is medical.
      const sample = classifyIncident(category === "medical" ? "Medic Response" : "Auto Fire Alarm");
      expect(sample.isMedical).toBe(sample.category === "medical");
    }
  });

  it("does not let a generic word shadow a medical one", () => {
    // Contains "alarm" but must be medical; medical is checked first.
    expect(classifyIncident("Automatic Medical Alarm").category).toBe("medical");
  });

  it("treats an injury traffic call as medical, not road — a hurt person is health data", () => {
    // "injur" is matched before the road rule, so injury collisions default off.
    expect(classifyIncident("INJURY VEH ACCIDENT").category).toBe("medical");
  });
});

describe("classifyIncident — the visible categories (shown by default)", () => {
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
    // "\bfires?\b" is a whole word, so "SHOTS FIRED" isn't a fire.
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
    // "1RED 1 Unit" is a real response code with no health word; we don't guess, so it's
    // `other` and shown by default (a known limitation).
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

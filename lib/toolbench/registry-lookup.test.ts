import { describe, expect, it } from "vitest";

import {
  decodeMmsi,
  findIcaoBlock,
  ICAO_BLOCKS,
  icaoToNNumber,
  MID_REGIONS,
  MMSI_CATEGORIES,
  nNumberToIcao,
  parseIcaoHex,
  US_BLOCK_END,
  US_BLOCK_START,
  AIRCRAFT_REGISTRIES,
  VESSEL_REGISTRIES,
} from "./registry-lookup";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * REFERENCE VALUES FROM THE FAA'S OWN SYSTEM, 2026-09-01
 * ─────────────────────────────────────────────────────────────────────────────
 * Each pair below was read from the FAA N-Number Inquiry result page for that registration
 * (`registry.faa.gov/aircraftinquiry`), by hand, on 2026-09-01. The FAA publishes the Mode S
 * code in OCTAL, which is why the octal string is recorded here as well as the hex: the
 * octal is what the source actually said, and the hex is this test's own conversion of it.
 *
 * These are not this implementation's output checked against itself. They are seventeen
 * independent answers from the authority that assigns the numbers, and they caught a real
 * bug: an earlier version used the wide 25-per-letter spacing at the fifth character as well
 * as the earlier ones, which is correct for every registration of four characters or fewer
 * and wrong for five — so N1AA passed and N1234A did not.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const FAA_REFERENCE: readonly (readonly [string, string])[] = [
  ["N1", "50000001"],
  ["N1A", "50000002"],
  ["N1AA", "50000003"],
  ["N1Z", "50001101"],
  ["N1ZZ", "50001131"],
  ["N100AA", "50002265"],
  ["N123Z", "50060426"],
  ["N1234A", "50060674"],
  ["N1234Z", "50060723"],
  ["N12345", "50060731"],
  ["N500AB", "51434762"],
  ["N612UA", "51773757"],
  ["N7AA", "52247735"],
  ["N8000", "52562065"],
  ["N999ZZ", "53373151"],
  ["N9999Z", "53373675"],
  ["N99999", "53373707"],
];

function octalToValue(octal: string): number {
  return Number.parseInt(octal, 8);
}

describe("US N-number to ICAO address", () => {
  it("reproduces every Mode S code the FAA publishes for these registrations", () => {
    for (const [registration, octal] of FAA_REFERENCE) {
      const expected = octalToValue(octal);
      const result = nNumberToIcao(registration);
      expect(result.ok, registration).toBe(true);
      if (!result.ok) continue;
      expect(result.value.value, `${registration} (FAA octal ${octal})`).toBe(expected);
    }
  });

  /**
   * The two ends of the block, which are also the two values the block's size is derived
   * from: N1 is A00001 and N99999 is ADF7C7, and the 915,399 addresses between them are
   * exactly 9 × 101,711 — the identity that says the slot constants are the real ones.
   */
  it("puts N1 at the bottom of the US block and N99999 at the top", () => {
    const first = nNumberToIcao("N1");
    const last = nNumberToIcao("N99999");
    expect(first.ok && first.value.hex).toBe("A00001");
    expect(last.ok && last.value.hex).toBe("ADF7C7");
    expect(US_BLOCK_END - US_BLOCK_START + 1).toBe(9 * 101_711);
    expect(US_BLOCK_END - US_BLOCK_START + 1).toBe(915_399);
  });

  it("accepts the forms a feed or a document actually writes", () => {
    for (const written of ["N612UA", "n612ua", "612UA", " N612UA "]) {
      const result = nNumberToIcao(written);
      expect(result.ok, written).toBe(true);
      if (result.ok) expect(result.value.hex, written).toBe("A7F7EF");
    }
  });

  it("refuses the shapes that look like registrations and are not", () => {
    const refusals = [
      "N0",       // a leading zero is never issued
      "N",        // nothing after the N
      "N123456",  // six characters after the N
      "N1A2",     // a digit after a letter
      "N1I",      // I is not in the alphabet
      "N1O",      // nor is O
      "N1234AB",  // two letters cannot follow four digits
      "NABC",     // must start with a digit
      "N-612UA",  // a hyphen is not part of a US registration
    ];
    for (const registration of refusals) {
      expect(nNumberToIcao(registration).ok, registration).toBe(false);
    }
  });
});

describe("ICAO address to US N-number", () => {
  it("inverts every FAA reference value", () => {
    for (const [registration, octal] of FAA_REFERENCE) {
      const value = octalToValue(octal);
      const hex = value.toString(16).toUpperCase().padStart(6, "0");
      const result = icaoToNNumber({ hex, value });
      expect(result.ok, hex).toBe(true);
      if (result.ok) expect(result.value, `${hex} should decode to ${registration}`).toBe(registration);
    }
  });

  /**
   * THE EXHAUSTIVE CHECK. Every one of the 915,399 addresses in the US block is decoded to a
   * registration and re-encoded, and must come back to the address it started from.
   *
   * A round trip alone would pass just as happily with the wrong constants — which is why the
   * FAA reference values above exist. Together they pin it: the reference values say the
   * mapping is right at seventeen points, and this says it is consistent everywhere else, so
   * no address in the block decodes to a registration belonging to a different aircraft.
   */
  it("round-trips every address in the US block", () => {
    let failures = 0;
    let firstFailure = "";
    for (let value = US_BLOCK_START; value <= US_BLOCK_END; value += 1) {
      const hex = value.toString(16).toUpperCase().padStart(6, "0");
      const registration = icaoToNNumber({ hex, value });
      if (!registration.ok) {
        failures += 1;
        if (!firstFailure) firstFailure = `${hex}: ${registration.error}`;
        continue;
      }
      const back = nNumberToIcao(registration.value);
      if (!back.ok || back.value.value !== value) {
        failures += 1;
        if (!firstFailure) firstFailure = `${hex} -> ${registration.value} -> ${back.ok ? back.value.hex : back.error}`;
      }
    }
    expect(failures, firstFailure).toBe(0);
  });

  it("refuses an address outside the US block, and names the country when it knows it", () => {
    const german = parseIcaoHex("3C4B49");
    expect(german.ok).toBe(true);
    if (!german.ok) return;
    const result = icaoToNNumber(german.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Germany");
  });
});

describe("hex parsing", () => {
  it("accepts the notations feeds and documents use", () => {
    for (const written of ["4CA6C4", "4ca6c4", "0x4CA6C4", "4C A6 C4", "4C-A6-C4"]) {
      const result = parseIcaoHex(written);
      expect(result.ok, written).toBe(true);
      if (result.ok) expect(result.value.hex, written).toBe("4CA6C4");
    }
  });

  /**
   * A short hex is nearly always a value whose leading zeros were eaten by a spreadsheet, so
   * the refusal says so and offers the padded form rather than silently padding it — padding
   * it would be a guess presented as a fact.
   */
  it("refuses a short address and suggests the zero-padded form", () => {
    const result = parseIcaoHex("4CA6C");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("04CA6C");
  });

  it("refuses non-hexadecimal text and the all-zero address", () => {
    expect(parseIcaoHex("G-EUYB").ok).toBe(false);
    expect(parseIcaoHex("").ok).toBe(false);
    expect(parseIcaoHex("000000").ok).toBe(false);
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * COUNTRY BLOCK ANCHORS — real aircraft, observed broadcasting
 * ─────────────────────────────────────────────────────────────────────────────
 * Each entry is a hex address and the registration that aircraft was broadcasting alongside
 * it, captured from adsb.lol on 2026-09-01 over Tokyo, Sydney, Delhi, São Paulo, Dubai,
 * Johannesburg, Moscow and Israel, plus the London capture already in this repository at
 * `lib/sources/__fixtures__/adsb-lol.json`.
 *
 * This is the evidence behind every row of `ICAO_BLOCKS`. A block with no anchor is not in
 * the table, which is why the table is partial and says so.
 */
const BLOCK_ANCHORS: readonly (readonly [string, string, string])[] = [
  ["04004C", "ET-", "Ethiopia"],
  ["0100E0", "SU-", "Egypt"],
  ["06A093", "A7-", "Qatar"],
  ["0C210C", "HP-", "Panama"],
  ["151DE6", "RA-", "Russian Federation"],
  ["300A95", "I-", "Italy"],
  ["3483CB", "EC-", "Spain"],
  ["398569", "F-", "France"],
  ["3C4B49", "D-", "Germany"],
  ["4005BE", "G-", "United Kingdom"],
  ["424C62", "M- (Isle of Man)", "United Kingdom"],
  ["43F824", "2- (Guernsey)", "United Kingdom"],
  ["44037C", "OE-", "Austria"],
  ["452142", "LZ-", "Bulgaria"],
  ["46B8B2", "SX-", "Greece"],
  ["471E16", "HA-", "Hungary"],
  ["47A31A", "LN-", "Norway"],
  ["48418A", "PH-", "Netherlands"],
  ["489229", "SP-", "Poland"],
  ["49514A", "CS-", "Portugal"],
  ["4A0483", "YR-", "Romania"],
  ["4ACA8E", "SE-", "Sweden"],
  ["4BA9C9", "TC-", "Türkiye"],
  ["4C066D", "YU-", "Serbia"],
  ["4CA6C4", "EI-", "Ireland"],
  ["4D0107", "LX-", "Luxembourg"],
  ["4D203A", "9H-", "Malta"],
  ["70AA75", "9N-", "Nepal"],
  ["70C0F7", "A4O-", "Oman"],
  ["70E071", "XU-", "Cambodia"],
  ["710120", "HZ-", "Saudi Arabia"],
  ["71BA13", "HL", "Republic of Korea"],
  ["738050", "4X-", "Israel"],
  ["740732", "JY-", "Jordan"],
  ["748027", "OD-", "Lebanon"],
  ["75054C", "9M-", "Malaysia"],
  ["7584A8", "RP-", "Philippines"],
  ["760999", "AP-", "Pakistan"],
  ["76CC73", "9V-", "Singapore"],
  ["780A1D", "B-", "China"],
  ["7C01A9", "VH-", "Australia"],
  ["8003B2", "VT-", "India"],
  ["8406D0", "JA", "Japan"],
  ["885106", "HS-", "Thailand"],
  ["8880DC", "VN-", "Viet Nam"],
  ["8940D3", "A9C-", "Bahrain"],
  ["896121", "A6-", "United Arab Emirates"],
  ["89912D", "B-", "Chinese Taipei"],
  ["A15EBC", "N", "United States"],
  ["C085D5", "C-", "Canada"],
  ["C81E05", "ZK-", "New Zealand"],
  ["E0B14A", "LV-", "Argentina"],
  ["E47FFE", "PR-", "Brazil"],
  ["E80214", "CC-", "Chile"],
];

describe("ICAO country blocks", () => {
  it("resolves every anchor to the country its registration says it is", () => {
    for (const [hex, registration, country] of BLOCK_ANCHORS) {
      const parsed = parseIcaoHex(hex);
      expect(parsed.ok, hex).toBe(true);
      if (!parsed.ok) continue;
      const block = findIcaoBlock(parsed.value.value);
      expect(block, `${hex} (${registration})`).not.toBeNull();
      expect(block?.country, `${hex} broadcasting ${registration}`).toBe(country);
    }
  });

  it("lists the registration prefix each anchor was actually carrying", () => {
    for (const [hex, registration] of BLOCK_ANCHORS) {
      const parsed = parseIcaoHex(hex);
      if (!parsed.ok) continue;
      const block = findIcaoBlock(parsed.value.value);
      expect(block?.prefixes, `${hex}`).toContain(registration);
    }
  });

  it("has at least one anchor for every block in the table", () => {
    const anchored = new Set(
      BLOCK_ANCHORS.map(([hex]) => {
        const parsed = parseIcaoHex(hex);
        return parsed.ok ? findIcaoBlock(parsed.value.value)?.country : undefined;
      }),
    );
    for (const block of ICAO_BLOCKS) {
      expect(anchored, `${block.country} has no observed anchor`).toContain(block.country);
    }
  });

  it("has no overlapping blocks, which would make the answer order-dependent", () => {
    const sorted = [...ICAO_BLOCKS].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i += 1) {
      const block = sorted[i];
      const next = sorted[i + 1];
      expect(block).toBeDefined();
      if (!block) continue;
      expect(block.start, block.country).toBeLessThanOrEqual(block.end);
      expect(block.end, block.country).toBeLessThanOrEqual(0xffffff);
      if (next) expect(next.start, `${block.country} overlaps ${next.country}`).toBeGreaterThan(block.end);
    }
  });

  /**
   * The honest null. An address in a real national block this table does not cover must come
   * back as "unknown to this tool", not as the nearest country in the list.
   */
  it("returns null outside every listed block rather than guessing", () => {
    // 0x200000 sits in a range no anchor covers.
    expect(findIcaoBlock(0x200000)).toBeNull();
    expect(findIcaoBlock(0xffffff)).toBeNull();
  });
});

describe("MMSI", () => {
  /**
   * The formats are from ITU-R M.585. Each case below is the documented shape rather than a
   * real vessel's number, because the shape is what is being tested and a real MMSI is a
   * fact about a specific ship that this repository has no business asserting.
   */
  it("recognises each documented format by its leading digits", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["244123456", "ship"],
      ["024412345", "groupOfShips"],
      ["002442345", "coastStation"],
      ["111244123", "sarAircraft"],
      ["992441234", "aidToNavigation"],
      ["982441234", "craftWithParent"],
      ["970244123", "aisSart"],
      ["972244123", "mob"],
      ["974244123", "epirbAis"],
      ["824412345", "handheldVhf"],
    ];
    for (const [mmsi, category] of cases) {
      const result = decodeMmsi(mmsi);
      expect(result.ok, mmsi).toBe(true);
      if (result.ok) expect(result.value.category.id, mmsi).toBe(category);
    }
  });

  /**
   * Ordering matters: 970/972/974 must be tested before the generic 9 forms, and 00 before
   * 0. Reversing either would classify a distress beacon as an aid to navigation.
   */
  it("prefers the more specific prefix, so a distress beacon is not read as a buoy", () => {
    const sart = decodeMmsi("970123456");
    expect(sart.ok && sart.value.category.id).toBe("aisSart");
    const aton = decodeMmsi("991234567");
    expect(aton.ok && aton.value.category.id).toBe("aidToNavigation");
    const coast = decodeMmsi("002191000");
    expect(coast.ok && coast.value.category.id).toBe("coastStation");
    const group = decodeMmsi("021910000");
    expect(group.ok && group.value.category.id).toBe("groupOfShips");
  });

  it("reads the MID from wherever the format puts it", () => {
    const ship = decodeMmsi("244123456");
    expect(ship.ok && ship.value.mid).toBe("244");
    const aton = decodeMmsi("992441234");
    expect(aton.ok && aton.value.mid).toBe("244");
    const sart = decodeMmsi("970244123");
    expect(sart.ok && sart.value.mid).toBe("244");
    const coast = decodeMmsi("002442345");
    expect(coast.ok && coast.value.mid).toBe("244");
  });

  it("names the region from the MID's first digit and claims nothing more", () => {
    const european = decodeMmsi("244123456");
    expect(european.ok && european.value.region).toBe("Europe");
    const asian = decodeMmsi("477123456");
    expect(asian.ok && asian.value.region).toBe("Asia");
    const african = decodeMmsi("677123456");
    expect(african.ok && african.value.region).toBe("Africa");
    expect(Object.keys(MID_REGIONS).sort()).toEqual(["2", "3", "4", "5", "6", "7"]);
  });

  it("refuses anything that is not nine digits, and says why leading zeros matter", () => {
    const short = decodeMmsi("24412345");
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error).toContain("Leading zeros");
    expect(decodeMmsi("2441234567").ok).toBe(false);
    expect(decodeMmsi("MMSI244123456").ok).toBe(false);
    expect(decodeMmsi("").ok).toBe(false);
  });

  it("refuses a leading digit no format uses", () => {
    // 1 alone (not 111) and 9 alone (not 97/98/99) are not assigned forms.
    expect(decodeMmsi("123456789").ok).toBe(false);
    expect(decodeMmsi("912345678").ok).toBe(false);
  });

  it("tolerates the separators people paste", () => {
    const spaced = decodeMmsi("244 123 456");
    expect(spaced.ok && spaced.value.mmsi).toBe("244123456");
  });

  it("describes every category it can return", () => {
    for (const info of Object.values(MMSI_CATEGORIES)) {
      expect(info.description.length, info.id).toBeGreaterThan(60);
      expect(info.label.length, info.id).toBeGreaterThan(3);
    }
  });
});

describe("the registries this tool links to instead of querying", () => {
  it("gives every link an operator and a note explaining what it is for", () => {
    for (const registry of [...AIRCRAFT_REGISTRIES, ...VESSEL_REGISTRIES]) {
      expect(registry.url.startsWith("https://"), registry.id).toBe(true);
      expect(registry.operator.length, registry.id).toBeGreaterThan(3);
      expect(registry.note.length, registry.id).toBeGreaterThan(60);
    }
  });

  it("offers a vessel route even though no vessel registry is queried", () => {
    expect(VESSEL_REGISTRIES.length).toBeGreaterThan(0);
  });
});

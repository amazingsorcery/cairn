import { fail, ok, type ToolResult } from "./result";

/**
 * Aircraft and vessel identifier decoding — entirely in the browser, against no registry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS TOOL DELIBERATELY DOES NOT DO, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * It does not query the FAA aircraft registry, or any other registry, from our server.
 *
 * The FAA's N-Number Inquiry works and its data is US public domain. It was exercised by
 * hand on 2026-09-01 to obtain the reference values this file is tested against. Three
 * things stopped it becoming a backend, and the third is decisive:
 *
 * 1. **There is no API and no published rate limit.** `registry.faa.gov/aircraftinquiry`
 *    serves HTML built for a person. Source-acceptance criterion 4 requires a documented
 *    rate limit the adapter's TTL respects, or a measured one — and measuring an unpublished
 *    limit means deliberately loading a government system to find where it breaks.
 *
 * 2. **The response is a page, not a contract.** A markup change would silently produce
 *    wrong or empty registry facts about a named aircraft owner. Wrong data about a named
 *    person is the worst failure this tool could have.
 *
 * 3. **The record contains the owner's postal address.** The N-Number result page returns
 *    the registrant's street, city, state, ZIP and county, and for a privately owned
 *    aircraft that is a named individual's home address. Standing constraint 3 and
 *    source-acceptance criterion 6: proxying that through our server, cached and served on
 *    demand, would make this product a personal-data lookup for aircraft owners. That is a
 *    thing we decline to be, and it is a decision rather than a technical limitation.
 *
 * So the FAA registry is LINKED, not proxied. The reader goes there themselves, sees the
 * federal system notice themselves, and their query is between them and the FAA.
 *
 * **No vessel registry is queried either.** No source was found whose terms permit
 * programmatic third-party use for ship particulars, so none is claimed. product-brief §6:
 * omission is always allowed; fabrication never is.
 *
 * What IS here is the arithmetic — which is genuinely useful, entirely deterministic, and
 * checkable against published values:
 *
 *   - US N-number ↔ ICAO 24-bit address, both directions. This is a real daily problem: an
 *     ADS-B feed gives you a hex, a registry gives you a tail number, and they are different
 *     encodings of the same aircraft.
 *   - Which national block an ICAO address falls in.
 *   - What an MMSI's digits say about the station it belongs to.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ================================================================== *
 * ICAO 24-bit addresses
 * ================================================================== */

export interface IcaoAddress {
  /** Uppercase, six hex digits, no separators. */
  readonly hex: string;
  readonly value: number;
}

/**
 * Parse a hex address, tolerating the ways feeds and documents write one.
 *
 * Lowercase (`4ca6c4`, the JSON feeds' form), spaced or dashed, and a leading `0x` are all
 * accepted. Anything else is refused rather than guessed at.
 */
export function parseIcaoHex(text: string): ToolResult<IcaoAddress> {
  const cleaned = text.trim().replace(/^0x/i, "").replace(/[\s-]/g, "").toUpperCase();
  if (cleaned.length === 0) return fail("Enter a six-digit hexadecimal ICAO address.");
  if (!/^[0-9A-F]{1,6}$/.test(cleaned)) {
    return fail(`“${text.trim()}” is not a hexadecimal number. An ICAO address is six hex digits, such as 4CA6C4.`);
  }
  if (cleaned.length < 6) {
    return fail(
      `An ICAO address is exactly six hex digits; this one has ${cleaned.length}. If it was quoted with leading zeros stripped, put them back: ${cleaned.padStart(6, "0")}.`,
    );
  }

  const value = Number.parseInt(cleaned, 16);
  if (value === 0) {
    return fail(
      "000000 is not an assigned address. Transponders that have never been configured broadcast it, and so do some test transmitters.",
    );
  }
  return ok({ hex: cleaned, value });
}

export interface IcaoBlock {
  readonly start: number;
  readonly end: number;
  /** The state of registry the block is allocated to. */
  readonly country: string;
  /** Registration prefixes issued by that state, as they are written on the aircraft. */
  readonly prefixes: readonly string[];
}

/**
 * National blocks in the ICAO 24-bit address space.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVENANCE, WHICH MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS FILE
 * ─────────────────────────────────────────────────────────────────────────────
 * **Every block below was checked against real aircraft observed broadcasting from it.**
 * The anchors are hex/registration pairs from ADS-B captures taken on 2026-09-01 over
 * Tokyo, Sydney, Delhi, São Paulo, Dubai, Johannesburg, Moscow and Israel, plus the London
 * capture already in this repository at `lib/sources/__fixtures__/adsb-lol.json`. Each
 * anchor is written out in `registry-lookup.test.ts` and asserted.
 *
 * **The table is therefore partial, and that is deliberate.** Blocks nobody could check are
 * not listed, and an address outside every listed block returns null — which the UI renders
 * as "not in a block this tool has verified", a statement about this tool rather than about
 * the address. A confident wrong country on an aircraft is exactly the kind of error that
 * survives into a published story.
 *
 * Some ranges are narrower than the full national allocation for the same reason: where the
 * observations only support a smaller window, the smaller window is what is written.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const ICAO_BLOCKS: readonly IcaoBlock[] = [
  { start: 0x040000, end: 0x043fff, country: "Ethiopia", prefixes: ["ET-"] },
  { start: 0x010000, end: 0x017fff, country: "Egypt", prefixes: ["SU-"] },
  { start: 0x06a000, end: 0x06afff, country: "Qatar", prefixes: ["A7-"] },
  { start: 0x0c2000, end: 0x0c2fff, country: "Panama", prefixes: ["HP-"] },
  { start: 0x140000, end: 0x17ffff, country: "Russian Federation", prefixes: ["RA-"] },
  { start: 0x300000, end: 0x33ffff, country: "Italy", prefixes: ["I-"] },
  { start: 0x340000, end: 0x37ffff, country: "Spain", prefixes: ["EC-"] },
  { start: 0x380000, end: 0x3bffff, country: "France", prefixes: ["F-"] },
  { start: 0x3c0000, end: 0x3fffff, country: "Germany", prefixes: ["D-"] },
  {
    start: 0x400000,
    end: 0x43ffff,
    country: "United Kingdom",
    // The Crown Dependencies register under the UK's block, which is why a Guernsey
    // 2-REG or an Isle of Man M- aircraft resolves here rather than to a country of its own.
    prefixes: ["G-", "M- (Isle of Man)", "2- (Guernsey)"],
  },
  { start: 0x440000, end: 0x447fff, country: "Austria", prefixes: ["OE-"] },
  { start: 0x450000, end: 0x457fff, country: "Bulgaria", prefixes: ["LZ-"] },
  { start: 0x468000, end: 0x46ffff, country: "Greece", prefixes: ["SX-"] },
  { start: 0x470000, end: 0x477fff, country: "Hungary", prefixes: ["HA-"] },
  { start: 0x478000, end: 0x47ffff, country: "Norway", prefixes: ["LN-"] },
  { start: 0x480000, end: 0x487fff, country: "Netherlands", prefixes: ["PH-"] },
  { start: 0x488000, end: 0x48ffff, country: "Poland", prefixes: ["SP-"] },
  { start: 0x490000, end: 0x497fff, country: "Portugal", prefixes: ["CS-"] },
  { start: 0x4a0000, end: 0x4a7fff, country: "Romania", prefixes: ["YR-"] },
  { start: 0x4a8000, end: 0x4affff, country: "Sweden", prefixes: ["SE-"] },
  { start: 0x4b8000, end: 0x4bffff, country: "Türkiye", prefixes: ["TC-"] },
  { start: 0x4c0000, end: 0x4c0fff, country: "Serbia", prefixes: ["YU-"] },
  { start: 0x4ca000, end: 0x4cafff, country: "Ireland", prefixes: ["EI-"] },
  { start: 0x4d0000, end: 0x4d02ff, country: "Luxembourg", prefixes: ["LX-"] },
  { start: 0x4d2000, end: 0x4d23ff, country: "Malta", prefixes: ["9H-"] },
  { start: 0x70a000, end: 0x70afff, country: "Nepal", prefixes: ["9N-"] },
  { start: 0x70c000, end: 0x70c3ff, country: "Oman", prefixes: ["A4O-"] },
  { start: 0x70e000, end: 0x70efff, country: "Cambodia", prefixes: ["XU-"] },
  { start: 0x710000, end: 0x717fff, country: "Saudi Arabia", prefixes: ["HZ-"] },
  { start: 0x718000, end: 0x71ffff, country: "Republic of Korea", prefixes: ["HL"] },
  { start: 0x738000, end: 0x73ffff, country: "Israel", prefixes: ["4X-"] },
  { start: 0x740000, end: 0x747fff, country: "Jordan", prefixes: ["JY-"] },
  { start: 0x748000, end: 0x74ffff, country: "Lebanon", prefixes: ["OD-"] },
  { start: 0x750000, end: 0x757fff, country: "Malaysia", prefixes: ["9M-"] },
  { start: 0x758000, end: 0x75ffff, country: "Philippines", prefixes: ["RP-"] },
  { start: 0x760000, end: 0x767fff, country: "Pakistan", prefixes: ["AP-"] },
  { start: 0x768000, end: 0x76ffff, country: "Singapore", prefixes: ["9V-"] },
  { start: 0x780000, end: 0x7bffff, country: "China", prefixes: ["B-"] },
  { start: 0x7c0000, end: 0x7fffff, country: "Australia", prefixes: ["VH-"] },
  { start: 0x800000, end: 0x83ffff, country: "India", prefixes: ["VT-"] },
  { start: 0x840000, end: 0x87ffff, country: "Japan", prefixes: ["JA"] },
  { start: 0x880000, end: 0x887fff, country: "Thailand", prefixes: ["HS-"] },
  { start: 0x888000, end: 0x88ffff, country: "Viet Nam", prefixes: ["VN-"] },
  { start: 0x894000, end: 0x8943ff, country: "Bahrain", prefixes: ["A9C-"] },
  { start: 0x896000, end: 0x896fff, country: "United Arab Emirates", prefixes: ["A6-"] },
  { start: 0x899000, end: 0x8993ff, country: "Chinese Taipei", prefixes: ["B-"] },
  { start: 0xa00000, end: 0xafffff, country: "United States", prefixes: ["N"] },
  { start: 0xc00000, end: 0xc3ffff, country: "Canada", prefixes: ["C-"] },
  { start: 0xc80000, end: 0xc87fff, country: "New Zealand", prefixes: ["ZK-"] },
  { start: 0xe00000, end: 0xe3ffff, country: "Argentina", prefixes: ["LV-"] },
  { start: 0xe40000, end: 0xe7ffff, country: "Brazil", prefixes: ["PP-", "PR-", "PS-", "PT-"] },
  { start: 0xe80000, end: 0xe80fff, country: "Chile", prefixes: ["CC-"] },
];

/** The block an address falls in, or null when it is outside every verified block. */
export function findIcaoBlock(value: number): IcaoBlock | null {
  return ICAO_BLOCKS.find((block) => value >= block.start && value <= block.end) ?? null;
}

/* ------------------------------------------------------------------ *
 * US N-numbers
 * ------------------------------------------------------------------ */

/**
 * The FAA's 24-letter alphabet: I and O are excluded, because they are read as 1 and 0.
 * The order below IS the encoding order and must not be sorted differently.
 */
const N_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** First US address, which is N1. Confirmed against the FAA's own record for N1. */
export const US_BLOCK_START = 0xa00001;
/** Last US address, which is N99999. Confirmed against the FAA's own record for N99999. */
export const US_BLOCK_END = 0xadf7c7;

/**
 * The size of the value space reachable from each remaining position.
 *
 * `SLOT[k]` is the number of distinct N-numbers that share the first `k` characters after
 * the N. Each slot is: 1 (stop here) + the letter suffixes reachable + 10 × the next slot.
 *
 *   SLOT_5 = 1 + 24 + 10×1        =     35   (fifth position: a letter or a digit, then stop)
 *   SLOT_4 = 1 + 24×25 + 10×35    =    951
 *   SLOT_3 = 1 + 24×25 + 10×951   =  10111
 *   SLOT_2 = 1 + 24×25 + 10×10111 = 101711
 *
 * and 9 × 101711 = 915,399, which is exactly `US_BLOCK_END − US_BLOCK_START + 1`. That
 * identity is the check that the constants are the real ones and not approximately right.
 */
const SLOT_2 = 101_711;
const SLOT_3 = 10_111;
const SLOT_4 = 951;
const SLOT_5 = 35;

/**
 * Where the digit branch starts inside a slot.
 *
 * At positions 2 to 4 a letter may be followed by a second letter, so the letter branch is
 * 24 × 25 = 600 values wide and digits start at 601. At position 5 there is no room for a
 * second letter, so the letter branch is 24 wide and digits start at 25. Getting this wrong
 * produces correct answers for every N-number of four characters or fewer and wrong ones for
 * five-digit registrations — which is most of the fleet, and is exactly the bug the FAA
 * reference values below caught.
 */
const DIGIT_BASE_EARLY = 601;
const DIGIT_BASE_LAST = 25;

function letterIndex(character: string): number {
  return N_ALPHABET.indexOf(character);
}

/**
 * Offset of a 0-, 1- or 2-letter suffix within its slot. 0 means "no suffix".
 *
 * `isLast` is not cosmetic. At positions 2 to 4 each first letter owns 25 offsets — itself
 * and its 24 two-letter children — so `B` is at 26. At position 5 no second letter can
 * follow, the letters are simply 1 to 24, and `B` is at 2. Using the wide spacing at the
 * last position pushes a five-character registration past its own slot and into the next
 * aircraft's address.
 */
function suffixOffset(letters: string, isLast: boolean): number | null {
  if (letters.length === 0) return 0;
  const first = letterIndex(letters[0] ?? "");
  if (first < 0) return null;
  if (isLast) return letters.length === 1 ? 1 + first : null;
  if (letters.length === 1) return 1 + first * 25;
  if (letters.length > 2) return null;
  const second = letterIndex(letters[1] ?? "");
  if (second < 0) return null;
  return 1 + first * 25 + second + 1;
}

/** `true` for a single ASCII digit. */
function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

/**
 * A US registration to its ICAO 24-bit address.
 *
 * Accepts `N612UA`, `n612ua` and `612UA`. Rejects anything that is not a well-formed
 * N-number, including the shapes that look valid — a letter followed by a digit
 * (`N1A2`), the letters I and O, and more than five characters after the N.
 */
export function nNumberToIcao(input: string): ToolResult<IcaoAddress> {
  const raw = input.trim().toUpperCase().replace(/\s/g, "");
  const body = raw.startsWith("N") ? raw.slice(1) : raw;

  if (body.length === 0) return fail("Enter a US registration, such as N612UA.");
  if (body.length > 5) {
    return fail("A US registration has at most five characters after the N.");
  }
  if (!isDigit(body[0] ?? "") || body[0] === "0") {
    return fail("A US registration starts with a digit from 1 to 9 after the N.");
  }

  const slots = [SLOT_3, SLOT_4, SLOT_5, 1] as const;
  let value = US_BLOCK_START + (Number(body[0]) - 1) * SLOT_2;
  let index = 1;
  let depth = 0;

  while (index < body.length) {
    const character = body[index] ?? "";
    const isLast = depth === slots.length - 1;

    if (isDigit(character)) {
      const digitBase = isLast ? DIGIT_BASE_LAST : DIGIT_BASE_EARLY;
      const nextSlot = slots[depth] ?? 1;
      value += digitBase + Number(character) * nextSlot;
      index += 1;
      depth += 1;
      continue;
    }

    // A letter ends the registration: nothing may follow it but one more letter.
    const letters = body.slice(index);
    if (isLast && letters.length > 1) {
      return fail(
        `${raw} is not a valid registration: only one letter may follow four digits (N1234A is valid, N1234AB is not).`,
      );
    }
    const offset = suffixOffset(letters, isLast);
    if (offset === null) {
      return fail(
        `${raw} is not a valid registration. Letters come last, at most two of them, and the letters I and O are never used because they read as 1 and 0.`,
      );
    }
    value += offset;
    index = body.length;
    break;
  }

  if (value < US_BLOCK_START || value > US_BLOCK_END) {
    return fail(`${raw} falls outside the US address block.`);
  }

  return ok({ hex: value.toString(16).toUpperCase().padStart(6, "0"), value });
}

/**
 * An ICAO address inside the US block back to its N-number.
 *
 * The exact inverse of the encoder above: the same slot sizes, walked outward instead of
 * inward. `registry-lookup.test.ts` round-trips every one of the FAA reference values and a
 * systematic sweep of the block, because an encoder and a decoder that agree with each other
 * and not with reality is the failure this pair is most prone to.
 */
export function icaoToNNumber(address: IcaoAddress): ToolResult<string> {
  if (address.value < US_BLOCK_START || address.value > US_BLOCK_END) {
    const block = findIcaoBlock(address.value);
    return fail(
      block === null
        ? `${address.hex} is not in the US block (A00001–ADF7C7). N-number conversion only applies to US-registered aircraft.`
        : `${address.hex} is allocated to ${block.country}, not the United States. N-number conversion only applies to US registrations.`,
    );
  }

  let remainder = address.value - US_BLOCK_START;
  const leading = Math.floor(remainder / SLOT_2) + 1;
  remainder %= SLOT_2;

  let result = `N${leading}`;
  const slots = [SLOT_3, SLOT_4, SLOT_5, 1] as const;

  for (let depth = 0; depth < slots.length; depth += 1) {
    if (remainder === 0) return ok(result);

    const isLast = depth === slots.length - 1;
    const digitBase = isLast ? DIGIT_BASE_LAST : DIGIT_BASE_EARLY;

    if (remainder < digitBase) {
      const suffix = decodeSuffix(remainder, isLast);
      if (suffix === null) return fail(`${address.hex} does not decode to a valid registration.`);
      return ok(result + suffix);
    }

    const nextSlot = slots[depth] ?? 1;
    const withoutBase = remainder - digitBase;
    const digit = Math.floor(withoutBase / nextSlot);
    if (digit > 9) return fail(`${address.hex} does not decode to a valid registration.`);
    result += String(digit);
    remainder = withoutBase % nextSlot;
  }

  return ok(result);
}

/** Inverse of `suffixOffset`. `isLast` forbids a second letter. */
function decodeSuffix(offset: number, isLast: boolean): string | null {
  if (offset === 0) return "";
  const zeroBased = offset - 1;
  if (isLast) {
    const letter = N_ALPHABET[zeroBased];
    return letter ?? null;
  }
  const first = Math.floor(zeroBased / 25);
  const second = zeroBased % 25;
  const firstLetter = N_ALPHABET[first];
  if (firstLetter === undefined) return null;
  if (second === 0) return firstLetter;
  const secondLetter = N_ALPHABET[second - 1];
  return secondLetter === undefined ? null : firstLetter + secondLetter;
}

/* ================================================================== *
 * MMSI
 * ================================================================== */

export type MmsiCategory =
  | "ship"
  | "groupOfShips"
  | "coastStation"
  | "sarAircraft"
  | "aidToNavigation"
  | "craftWithParent"
  | "aisSart"
  | "mob"
  | "epirbAis"
  | "handheldVhf";

export interface MmsiCategoryInfo {
  readonly id: MmsiCategory;
  readonly label: string;
  readonly description: string;
}

export const MMSI_CATEGORIES: Readonly<Record<MmsiCategory, MmsiCategoryInfo>> = {
  ship: {
    id: "ship",
    label: "Ship station",
    description:
      "An individual vessel. The first three digits are the MID of the administration that assigned it, which is the flag the vessel was registered under when the MMSI was issued.",
  },
  groupOfShips: {
    id: "groupOfShips",
    label: "Group of ship stations",
    description:
      "A fleet call, not a single vessel. Assigned to a group of ships under one administration; nothing about a hull can be inferred from it.",
  },
  coastStation: {
    id: "coastStation",
    label: "Coast station",
    description:
      "A shore station — a port authority, a VTS centre, a coastguard station. Not a moving object, and a track apparently belonging to one is usually a base station's own position report.",
  },
  sarAircraft: {
    id: "sarAircraft",
    label: "Search-and-rescue aircraft",
    description:
      "An aircraft transmitting AIS during a search-and-rescue operation. It will appear on a ship-tracking map, moving at speeds no vessel reaches.",
  },
  aidToNavigation: {
    id: "aidToNavigation",
    label: "Aid to navigation",
    description:
      "A buoy, beacon, lighthouse or offshore platform, real or virtual. Virtual aids exist only as a transmission from elsewhere — there may be nothing at the position at all.",
  },
  craftWithParent: {
    id: "craftWithParent",
    label: "Craft associated with a parent ship",
    description:
      "A tender, lifeboat or rescue craft carried by another vessel. The parent's identity is not encoded here; it has to be established from the traffic around it.",
  },
  aisSart: {
    id: "aisSart",
    label: "AIS search-and-rescue transmitter",
    description:
      "A survival-craft locating device. Its presence in a feed is a distress indication and should be treated as one.",
  },
  mob: {
    id: "mob",
    label: "Man-overboard device",
    description: "A personal AIS beacon activated when someone goes into the water.",
  },
  epirbAis: {
    id: "epirbAis",
    label: "AIS-EPIRB",
    description:
      "An emergency position-indicating radio beacon with an AIS transmitter, activated in distress.",
  },
  handheldVhf: {
    id: "handheldVhf",
    label: "Handheld VHF with DSC and GNSS",
    description:
      "A portable radio, not a vessel. It moves with whoever is carrying it, including off the water.",
  },
};

/**
 * The regions the first digit of an MID denotes, from ITU-R M.585's own allocation of the
 * MID series. This is the whole of what this tool claims about an MMSI's geography.
 *
 * **There is no MID-to-country table here, on purpose.** A three-digit MID does name a
 * specific administration, but no machine-readable list of the current assignments could be
 * verified during this build, and a table of roughly 250 entries transcribed from memory
 * would put a fabricated fact next to a real one with no way for a reader to tell which was
 * which. The ITU's MARS database is authoritative and is linked from the tool instead.
 */
export const MID_REGIONS: Readonly<Record<string, string>> = {
  "2": "Europe",
  "3": "North America, Central America and the Caribbean",
  "4": "Asia",
  "5": "Oceania",
  "6": "Africa",
  "7": "South America",
};

export interface MmsiDecoding {
  readonly mmsi: string;
  readonly category: MmsiCategoryInfo;
  /** The three MID digits, wherever in the number they sit. Null when the form carries none. */
  readonly mid: string | null;
  /** The region the MID's first digit denotes. Null when there is no MID. */
  readonly region: string | null;
}

/**
 * Decode the structure of an MMSI, per the formats in ITU-R M.585.
 *
 * The order of the tests below matters: `970`, `972` and `974` are more specific than the
 * `9` prefixes around them, and `00` is more specific than `0`.
 */
export function decodeMmsi(input: string): ToolResult<MmsiDecoding> {
  const digits = input.trim().replace(/[\s-]/g, "");
  if (digits.length === 0) return fail("Enter a nine-digit MMSI.");
  if (!/^[0-9]+$/.test(digits)) return fail("An MMSI is nine digits, and nothing but digits.");
  if (digits.length !== 9) {
    return fail(
      `An MMSI is exactly nine digits; this one has ${digits.length}. Leading zeros are part of the number and are frequently dropped by spreadsheets — if this came out of one, check the original.`,
    );
  }

  const decode = (category: MmsiCategory, mid: string | null): ToolResult<MmsiDecoding> =>
    ok({
      mmsi: digits,
      category: MMSI_CATEGORIES[category],
      mid,
      region: mid === null ? null : (MID_REGIONS[mid[0] ?? ""] ?? null),
    });

  if (digits.startsWith("970")) return decode("aisSart", digits.slice(3, 6));
  if (digits.startsWith("972")) return decode("mob", digits.slice(3, 6));
  if (digits.startsWith("974")) return decode("epirbAis", digits.slice(3, 6));
  if (digits.startsWith("98")) return decode("craftWithParent", digits.slice(2, 5));
  if (digits.startsWith("99")) return decode("aidToNavigation", digits.slice(2, 5));
  if (digits.startsWith("111")) return decode("sarAircraft", digits.slice(3, 6));
  if (digits.startsWith("00")) return decode("coastStation", digits.slice(2, 5));
  if (digits.startsWith("0")) return decode("groupOfShips", digits.slice(1, 4));
  if (digits.startsWith("8")) return decode("handheldVhf", digits.slice(1, 4));

  const leading = digits[0] ?? "";
  if (leading >= "2" && leading <= "7") return decode("ship", digits.slice(0, 3));

  return fail(
    `${digits} does not match any MMSI format in ITU-R M.585. A ship station's MMSI begins with a digit from 2 to 7; the other leading digits are reserved for the forms listed on this page.`,
  );
}

/* ================================================================== *
 * Where to go for the actual record
 * ================================================================== */

export interface AuthoritativeRegistry {
  readonly id: string;
  readonly label: string;
  readonly operator: string;
  readonly url: string;
  readonly note: string;
}

/**
 * Links, not lookups. Following one is the reader's own request to that operator, from their
 * own browser, with their own address — which is the whole reason this tool does not proxy.
 */
export const AIRCRAFT_REGISTRIES: readonly AuthoritativeRegistry[] = [
  {
    id: "faa",
    label: "FAA N-Number Inquiry",
    operator: "US Federal Aviation Administration",
    url: "https://registry.faa.gov/aircraftinquiry/Search/NNumberInquiry",
    note: "The authoritative US record: registrant, make and model, serial number, airworthiness, and the Mode S code in both octal and hexadecimal. Its data is US public domain. Note that it also shows the registrant's postal address, which for a privately owned aircraft is a person's home.",
  },
  {
    id: "faa-download",
    label: "FAA Releasable Aircraft Database",
    operator: "US Federal Aviation Administration",
    url: "https://registry.faa.gov/database/",
    note: "The same data as a downloadable file, updated each federal working day. This is the sanctioned route for anything more than a handful of lookups.",
  },
  {
    id: "uk-caa",
    label: "UK CAA G-INFO",
    operator: "UK Civil Aviation Authority",
    url: "https://siteapps.caa.co.uk/g-info/",
    note: "The UK register, searchable by registration, and the place to resolve a 4xxxxx hex once this tool has told you the address is British.",
  },
];

export const VESSEL_REGISTRIES: readonly AuthoritativeRegistry[] = [
  {
    id: "itu-mars",
    label: "ITU MARS — Maritime mobile Access and Retrieval System",
    operator: "International Telecommunication Union",
    url: "https://www.itu.int/mmsapp/ShipStation/list",
    note: "The authoritative record of MMSI assignments, including the MID-to-administration list this tool deliberately does not reproduce. Free to search; some detail requires an ITU account.",
  },
  {
    id: "imo-gisis",
    label: "IMO GISIS — Global Integrated Shipping Information System",
    operator: "International Maritime Organization",
    url: "https://gisis.imo.org/Public/SHIPS/Default.aspx",
    note: "IMO numbers, which unlike an MMSI stay with a hull through renaming and reflagging. Free registration required.",
  },
  {
    id: "equasis",
    label: "Equasis",
    operator: "Equasis (multi-administration public service)",
    url: "https://www.equasis.org/",
    note: "Particulars, name and flag history, and company identities. Free with registration, and the first stop in the vessel-tracing playbook.",
  },
];

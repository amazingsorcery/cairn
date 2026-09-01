import { z } from "zod";

import { fail, ok, type ToolResult } from "./result";

/**
 * The Overpass query builder's pure half: presets, bounding boxes, the query grammar, and
 * the response schema.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS A PARSER AND NOT A TEMPLATE
 * ─────────────────────────────────────────────────────────────────────────────
 * The tool lets a reader edit the generated Overpass QL, because a query builder that hides
 * the query teaches nobody the query language. But the string a reader has edited must never
 * be the string we send: Overpass QL can express a planet-wide extraction in forty
 * characters, and the public instances are a donated community service whose own manual
 * lists "setting up an app for more than just OSM mappers and relying on the public
 * instances as backend" as problematic behaviour.
 *
 * So the editable text is **parsed into a structure** and the structure is **re-emitted** by
 * `buildQuery`. What leaves this building is always our own generated string. This is the
 * same argument as a parameterised SQL statement: the user supplies values, never syntax.
 *
 * The consequences are honest and are stated on the tool page — the grammar below is a
 * strict subset of Overpass QL, `around:`, `area`, `is_in`, recursion and regular-expression
 * filters are all refused, and a reader who needs them is pointed at overpass-turbo, which
 * runs in their own browser against their own rate-limit identity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ------------------------------------------------------------------ *
 * Limits — every one of these is a number the upstream cares about
 * ------------------------------------------------------------------ */

/**
 * Declared run time, in seconds. The Overpass manual: "If no maximum run time is declared
 * then a default limit of 180 seconds applies", and the scheduler "admits a request if and
 * only if it is going to use in both criteria at most half of the remaining available
 * resources". A small declared limit is therefore not only polite, it is what gets a query
 * admitted when the server is busy.
 */
export const QUERY_TIMEOUT_SECONDS = 25;

/**
 * Declared memory, in bytes. The documented default is 512 MiB; 32 MiB is far more than a
 * bounded feature query needs and puts us at the front of the admission queue rather than
 * the back.
 */
export const QUERY_MAXSIZE_BYTES = 32 * 1024 * 1024;

/** Hard ceiling on `out`. A geolocation candidate list is single or double digits. */
export const MAX_RESULT_LIMIT = 1000;
export const DEFAULT_RESULT_LIMIT = 200;

/**
 * The largest search area we will submit, in square kilometres.
 *
 * 25,000 km² is roughly a 160 km square — a province, which is the scale the geolocation
 * playbook's step 3 asks for ("start with a bounding box, not a country"). Larger boxes are
 * refused rather than clamped, because silently shrinking somebody's search area produces a
 * null result they will read as "the feature is not there".
 */
export const MAX_BBOX_AREA_KM2 = 25_000;

/** Web Mercator's usable latitude range, and the one the reference basemaps cover. */
const MAX_LATITUDE = 85.05113;

/** Refuse absurd input before it reaches a parser. Real queries are a few hundred bytes. */
export const MAX_QUERY_LENGTH = 4_000;

export const MAX_STATEMENTS = 8;
export const MAX_FILTERS_PER_STATEMENT = 4;

/* ------------------------------------------------------------------ *
 * Bounding boxes
 * ------------------------------------------------------------------ */

export interface BoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

const EARTH_RADIUS_KM = 6371.0088;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Area of the spherical rectangle, in square kilometres.
 *
 * R² · Δλ · (sin φ_north − sin φ_south). Exact on a sphere, which is precise enough for a
 * guard rail by two orders of magnitude — and unlike Δlat × Δlon it does not claim that a
 * degree square at the equator and one at 70° N are the same size, which is the error that
 * would let an Arctic query through at four times its intended area.
 */
export function boundingBoxAreaKm2(box: BoundingBox): number {
  const deltaLongitude = toRadians(box.east - box.west);
  const sineSpan = Math.sin(toRadians(box.north)) - Math.sin(toRadians(box.south));
  return EARTH_RADIUS_KM * EARTH_RADIUS_KM * deltaLongitude * sineSpan;
}

/** Round to the precision Overpass and a URL both handle without noise. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Validate a box. Returns the reason it was refused, in words a reader can act on.
 *
 * An antimeridian crossing is refused rather than split. Overpass takes `west > east` as a
 * malformed box rather than as a wrap, so accepting one here would send a query that
 * silently returns nothing — the failure this codebase keeps meeting, arriving again.
 */
export function checkBoundingBox(box: BoundingBox): ToolResult<BoundingBox> {
  const values = [box.south, box.west, box.north, box.east];
  if (values.some((value) => !Number.isFinite(value))) {
    return fail("A bounding box needs four numbers: south, west, north, east.");
  }
  if (Math.abs(box.south) > MAX_LATITUDE || Math.abs(box.north) > MAX_LATITUDE) {
    return fail(
      `Latitudes must be between -${MAX_LATITUDE} and ${MAX_LATITUDE}. Web Mercator does not reach the poles.`,
    );
  }
  if (Math.abs(box.west) > 180 || Math.abs(box.east) > 180) {
    return fail("Longitudes must be between -180 and 180.");
  }
  if (box.south >= box.north) {
    return fail("The south edge must be below the north edge.");
  }
  if (box.west >= box.east) {
    return fail(
      "The west edge must be left of the east edge. A box that crosses the antimeridian has to be sent as two boxes.",
    );
  }

  const area = boundingBoxAreaKm2(box);
  if (area > MAX_BBOX_AREA_KM2) {
    return fail(
      `That box covers about ${Math.round(area).toLocaleString("en-GB")} km². This tool submits at most ` +
        `${MAX_BBOX_AREA_KM2.toLocaleString("en-GB")} km² — the public Overpass servers are a donated ` +
        `service and a country-sized query is what their usage policy asks callers not to send. Narrow ` +
        `the box, or run the query yourself in overpass-turbo.`,
    );
  }

  return ok({
    south: round6(box.south),
    west: round6(box.west),
    north: round6(box.north),
    east: round6(box.east),
  });
}

/**
 * Parse the four orderings a reader is likely to paste.
 *
 * `south,west,north,east` is Overpass's own order and the one the tool emits. OpenStreetMap's
 * export box and most GIS tools quote `west,south,east,north`, so both are accepted and the
 * caller says which it means — guessing from the numbers works until somebody pastes a box
 * near the equator, where both readings are valid and only one is right.
 */
export function parseBoundingBox(
  text: string,
  order: "swne" | "wsen" = "swne",
): ToolResult<BoundingBox> {
  const parts = text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length !== 4) {
    return fail("Give four numbers separated by commas.");
  }

  const numbers = parts.map((part) => Number(part));
  if (numbers.some((value) => Number.isNaN(value))) {
    return fail("All four values must be numbers in decimal degrees.");
  }

  const [a, b, c, d] = numbers as [number, number, number, number];
  const box: BoundingBox =
    order === "swne"
      ? { south: a, west: b, north: c, east: d }
      : { west: a, south: b, east: c, north: d };

  return checkBoundingBox(box);
}

/** `south,west,north,east` — the order Overpass's own `[bbox:]` setting takes. */
export function formatBoundingBox(box: BoundingBox): string {
  return `${box.south},${box.west},${box.north},${box.east}`;
}

/* ------------------------------------------------------------------ *
 * Feature presets
 * ------------------------------------------------------------------ */

export interface TagFilter {
  readonly key: string;
  /** Absent means "the key is present, with any value". */
  readonly value?: string;
  /** True for `!=` rather than `=`. */
  readonly negated?: boolean;
}

export type ElementSelector = "node" | "way" | "relation" | "nwr";

export interface QueryStatement {
  readonly selector: ElementSelector;
  readonly filters: readonly TagFilter[];
}

export interface FeaturePreset {
  readonly id: string;
  readonly label: string;
  /** What the tag actually means, so a null result can be read correctly. */
  readonly note: string;
  readonly group: PresetGroup;
  readonly statement: QueryStatement;
}

export type PresetGroup = "structures" | "transport" | "energy" | "industry" | "civic";

export const PRESET_GROUPS: readonly { readonly id: PresetGroup; readonly label: string }[] = [
  { id: "structures", label: "Tall and distinctive structures" },
  { id: "transport", label: "Transport" },
  { id: "energy", label: "Power and energy" },
  { id: "industry", label: "Industry and extraction" },
  { id: "civic", label: "Civic and public buildings" },
];

/**
 * `nwr` on every preset, deliberately.
 *
 * The geolocation playbook says it in as many words: "Use `nwr` to catch nodes, ways and
 * relations — a stadium may be tagged as any of them." A preset restricted to `node` finds
 * the water towers somebody mapped as a point and misses the ones mapped as a footprint,
 * and the reader has no way to know which they got.
 *
 * Every tag below is a documented OpenStreetMap tag in current use. Nothing here is invented;
 * where a feature needs two tags to be unambiguous — a football pitch is `leisure=pitch` plus
 * `sport=soccer`, a wind turbine is `power=generator` plus `generator:source=wind` — both are
 * emitted, because the single-tag version returns tennis courts and diesel generators.
 */
export const FEATURE_PRESETS: readonly FeaturePreset[] = [
  {
    id: "water-tower",
    label: "Water tower",
    note: "man_made=water_tower. Elevated storage tanks. Distinctive from the air and from the ground, and one of the highest-value geolocation features there is.",
    group: "structures",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "water_tower" }] },
  },
  {
    id: "communications-mast",
    label: "Communications mast",
    note: "man_made=mast. A guyed mast, as distinct from a self-supporting tower. Mapping of masts is patchy outside Europe.",
    group: "structures",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "mast" }] },
  },
  {
    id: "communications-tower",
    label: "Communications tower",
    note: "man_made=tower with tower:type=communication. Self-supporting lattice or concrete towers. Many are tagged only man_made=tower with no type, so run both queries.",
    group: "structures",
    statement: {
      selector: "nwr",
      filters: [
        { key: "man_made", value: "tower" },
        { key: "tower:type", value: "communication" },
      ],
    },
  },
  {
    id: "observation-tower",
    label: "Observation tower",
    note: "man_made=tower with tower:type=observation. Viewing towers, which are also the vantage points a photograph may have been taken from.",
    group: "structures",
    statement: {
      selector: "nwr",
      filters: [
        { key: "man_made", value: "tower" },
        { key: "tower:type", value: "observation" },
      ],
    },
  },
  {
    id: "chimney",
    label: "Industrial chimney",
    note: "man_made=chimney. Tall, visible from a long way, and rarely moved.",
    group: "industry",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "chimney" }] },
  },
  {
    id: "cooling-tower",
    label: "Cooling tower",
    note: "man_made=cooling_tower. The hyperboloid kind and the smaller industrial kind share this tag.",
    group: "industry",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "cooling_tower" }] },
  },
  {
    id: "storage-tank",
    label: "Storage tank",
    note: "man_made=storage_tank. Tank farms are a strong signature in overhead imagery and are usually mapped as areas rather than points.",
    group: "industry",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "storage_tank" }] },
  },
  {
    id: "silo",
    label: "Silo",
    note: "man_made=silo. Grain and cement silos. Common in agricultural regions and frequently the only tall structure for miles.",
    group: "industry",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "silo" }] },
  },
  {
    id: "lighthouse",
    label: "Lighthouse",
    note: "man_made=lighthouse. Nearly complete coverage worldwide, because they are also navigational data.",
    group: "structures",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "lighthouse" }] },
  },
  {
    id: "windmill",
    label: "Windmill",
    note: "man_made=windmill. The historic kind. A modern wind turbine is power=generator, which is a separate preset.",
    group: "structures",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "windmill" }] },
  },
  {
    id: "helipad",
    label: "Helipad",
    note: "aeroway=helipad. Hospital roofs, oil platforms, private estates. Mapped inconsistently; absence proves very little.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "aeroway", value: "helipad" }] },
  },
  {
    id: "aerodrome",
    label: "Airport or airfield",
    note: "aeroway=aerodrome. Everything from an international airport to a grass strip, so expect a wide spread of sizes.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "aeroway", value: "aerodrome" }] },
  },
  {
    id: "runway",
    label: "Runway",
    note: "aeroway=runway. Mapped as a way; the centre point returned is the middle of the strip, not either threshold.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "aeroway", value: "runway" }] },
  },
  {
    id: "level-crossing",
    label: "Level crossing",
    note: "railway=level_crossing. Road over rail at grade. A strong discriminator when combined with anything else, because they are sparse.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "railway", value: "level_crossing" }] },
  },
  {
    id: "railway-station",
    label: "Railway station",
    note: "railway=station. Excludes halts and tram stops, which carry railway=halt and railway=tram_stop.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "railway", value: "station" }] },
  },
  {
    id: "fuel-station",
    label: "Fuel station",
    note: "amenity=fuel. Dense in towns and near-useless alone; useful as the second or third constraint on a candidate area.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "amenity", value: "fuel" }] },
  },
  {
    id: "bridge",
    label: "Named bridge structure",
    note: "man_made=bridge, the bridge structure itself rather than the road carried over it. Most bridges are tagged only on the way, so this misses many.",
    group: "transport",
    statement: { selector: "nwr", filters: [{ key: "man_made", value: "bridge" }] },
  },
  {
    id: "wind-turbine",
    label: "Wind turbine",
    note: "power=generator with generator:source=wind. Individual turbines. A wind farm is usually mapped as both a plant area and its turbines.",
    group: "energy",
    statement: {
      selector: "nwr",
      filters: [
        { key: "power", value: "generator" },
        { key: "generator:source", value: "wind" },
      ],
    },
  },
  {
    id: "solar-plant",
    label: "Solar power plant",
    note: "power=plant with plant:source=solar. Utility-scale arrays, not rooftop panels.",
    group: "energy",
    statement: {
      selector: "nwr",
      filters: [
        { key: "power", value: "plant" },
        { key: "plant:source", value: "solar" },
      ],
    },
  },
  {
    id: "substation",
    label: "Electrical substation",
    note: "power=substation. Well mapped in most of Europe and North America because the power network is a mapping project in its own right.",
    group: "energy",
    statement: { selector: "nwr", filters: [{ key: "power", value: "substation" }] },
  },
  {
    id: "power-tower",
    label: "Transmission pylon",
    note: "power=tower. Individual lattice pylons. Extremely numerous, so only useful inside a small box or as a line to follow.",
    group: "energy",
    statement: { selector: "nwr", filters: [{ key: "power", value: "tower" }] },
  },
  {
    id: "quarry",
    label: "Quarry or open-cast mine",
    note: "landuse=quarry. Large, irregular and visible from orbit, which makes them good anchors in satellite imagery.",
    group: "industry",
    statement: { selector: "nwr", filters: [{ key: "landuse", value: "quarry" }] },
  },
  {
    id: "stadium",
    label: "Stadium",
    note: "leisure=stadium. The building. The playing surface inside is a separate leisure=pitch, which is why nwr matters here.",
    group: "civic",
    statement: { selector: "nwr", filters: [{ key: "leisure", value: "stadium" }] },
  },
  {
    id: "football-pitch",
    label: "Football pitch",
    note: "leisure=pitch with sport=soccer. Without the sport tag this returns every tennis court and basketball court as well.",
    group: "civic",
    statement: {
      selector: "nwr",
      filters: [
        { key: "leisure", value: "pitch" },
        { key: "sport", value: "soccer" },
      ],
    },
  },
  {
    id: "place-of-worship",
    label: "Place of worship",
    note: "amenity=place_of_worship. Add religion= or building= to narrow it; the bare tag covers every faith and every building shape.",
    group: "civic",
    statement: { selector: "nwr", filters: [{ key: "amenity", value: "place_of_worship" }] },
  },
  {
    id: "hospital",
    label: "Hospital",
    note: "amenity=hospital. Includes small clinics in some countries' mapping conventions, which is a common source of surprise.",
    group: "civic",
    statement: { selector: "nwr", filters: [{ key: "amenity", value: "hospital" }] },
  },
  {
    id: "fire-station",
    label: "Fire station",
    note: "amenity=fire_station. Sparse and distinctive, which makes it a good second constraint.",
    group: "civic",
    statement: { selector: "nwr", filters: [{ key: "amenity", value: "fire_station" }] },
  },
  {
    id: "military-land",
    label: "Military land",
    note: "landuse=military. Records what OpenStreetMap contributors have mapped as military land. Mapping is uneven and politically sensitive in some countries, so both presence and absence need care.",
    group: "civic",
    statement: { selector: "nwr", filters: [{ key: "landuse", value: "military" }] },
  },
];

export function findPreset(id: string): FeaturePreset | null {
  return FEATURE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function presetsInGroup(group: PresetGroup): readonly FeaturePreset[] {
  return FEATURE_PRESETS.filter((preset) => preset.group === group);
}

/* ------------------------------------------------------------------ *
 * The query grammar
 * ------------------------------------------------------------------ */

export interface QuerySpec {
  readonly bbox: BoundingBox;
  readonly statements: readonly QueryStatement[];
  readonly limit: number;
}

/**
 * The character sets a tag key and value may contain.
 *
 * Both are anchored allowlists rather than escapes. An OSM key is by convention lowercase
 * ASCII with underscores and colons; values are wider but a geolocation query does not need
 * a quote, a backslash, a bracket or a semicolon in one, and every one of those characters
 * is syntax in Overpass QL. Refusing them means the emitter never has to escape anything,
 * which is the only escaping strategy that cannot be got wrong.
 */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_:]{0,62}$/;
const VALUE_PATTERN = /^[A-Za-z0-9_:./+-][A-Za-z0-9_:./+ -]{0,62}$/;

export function isValidTagKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function isValidTagValue(value: string): boolean {
  return VALUE_PATTERN.test(value);
}

const SELECTORS: readonly ElementSelector[] = ["node", "way", "relation", "nwr"];

function isSelector(value: string): value is ElementSelector {
  return (SELECTORS as readonly string[]).includes(value);
}

function emitFilter(filter: TagFilter): string {
  if (filter.value === undefined) return `["${filter.key}"]`;
  return `["${filter.key}"${filter.negated === true ? "!=" : "="}"${filter.value}"]`;
}

/**
 * Emit the canonical query. This is the ONLY function that produces a string sent upstream.
 *
 * `[bbox:...]` is a global setting rather than a per-statement filter, which is what makes
 * the query bounded by construction: the Overpass manual defines the global bounding box as
 * applying to every statement that does not carry its own region, and the grammar below
 * refuses statements that carry one.
 */
export function buildQuery(spec: QuerySpec): string {
  const settings =
    `[out:json]` +
    `[timeout:${QUERY_TIMEOUT_SECONDS}]` +
    `[maxsize:${QUERY_MAXSIZE_BYTES}]` +
    `[bbox:${formatBoundingBox(spec.bbox)}];`;

  const body = spec.statements
    .map((statement) => `  ${statement.selector}${statement.filters.map(emitFilter).join("")};`)
    .join("\n");

  return `${settings}\n(\n${body}\n);\nout center ${spec.limit};\n`;
}

const SETTINGS_PATTERN =
  /^\[out:json\]\[timeout:(\d{1,3})\]\[maxsize:(\d{1,12})\]\[bbox:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\];$/;

const OUT_PATTERN = /^out center (\d{1,4});$/;

const FILTER_PATTERN = /\["([^"]*)"(?:(!?=)"([^"]*)")?\]/g;

/**
 * Parse an edited query back into a structure, refusing anything outside the grammar.
 *
 * The refusals carry the reason, because "invalid query" on a tool whose whole purpose is
 * teaching a query language is a wasted teaching moment. Each message says which construct
 * was refused and where a reader can run it instead.
 */
export function parseGuardedQuery(text: string): ToolResult<QuerySpec> {
  if (text.length > MAX_QUERY_LENGTH) {
    return fail(`A query here is at most ${MAX_QUERY_LENGTH} characters. This one is ${text.length}.`);
  }

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 4) {
    return fail("The query needs a settings line, a ( … ); block and an out statement.");
  }

  const settingsLine = lines[0] ?? "";
  const settings = SETTINGS_PATTERN.exec(settingsLine);
  if (!settings) {
    return fail(
      "The first line must be the settings line exactly as generated: " +
        `[out:json][timeout:${QUERY_TIMEOUT_SECONDS}][maxsize:${QUERY_MAXSIZE_BYTES}][bbox:south,west,north,east]; ` +
        "The bounding box lives there, and it is what keeps the query bounded — so it is not editable to " +
        "something else here. Change the box with the fields above.",
    );
  }

  const [, timeoutText, maxsizeText, southText, westText, northText, eastText] = settings as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (Number(timeoutText) > QUERY_TIMEOUT_SECONDS) {
    return fail(`The declared timeout may not exceed ${QUERY_TIMEOUT_SECONDS} seconds.`);
  }
  if (Number(maxsizeText) > QUERY_MAXSIZE_BYTES) {
    return fail(`The declared maxsize may not exceed ${QUERY_MAXSIZE_BYTES} bytes.`);
  }

  const boxCheck = checkBoundingBox({
    south: Number(southText),
    west: Number(westText),
    north: Number(northText),
    east: Number(eastText),
  });
  if (!boxCheck.ok) return boxCheck;

  if (lines[1] !== "(") {
    return fail("The second line must be an opening ( on its own, starting the union block.");
  }

  const closingIndex = lines.indexOf(");");
  if (closingIndex === -1) {
    return fail("The union block must be closed with ); on its own line.");
  }

  const statementLines = lines.slice(2, closingIndex);
  if (statementLines.length === 0) {
    return fail("Add at least one feature statement inside the ( … ); block.");
  }
  if (statementLines.length > MAX_STATEMENTS) {
    return fail(
      `At most ${MAX_STATEMENTS} statements. Each one is a separate pass over the data on a shared server.`,
    );
  }

  const statements: QueryStatement[] = [];
  for (const line of statementLines) {
    const parsed = parseStatement(line);
    if (!parsed.ok) return parsed;
    statements.push(parsed.value);
  }

  const outLines = lines.slice(closingIndex + 1);
  if (outLines.length !== 1) {
    return fail("There must be exactly one out statement, after the closing );.");
  }
  const outMatch = OUT_PATTERN.exec(outLines[0] ?? "");
  if (!outMatch) {
    return fail(
      "The last line must be `out center N;`. `out center` returns one representative point per " +
        "feature, which is all this tool renders; `out geom` and `out meta` return far more data " +
        "than that and are refused here.",
    );
  }
  const limit = Number(outMatch[1]);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
    return fail(`The out limit must be between 1 and ${MAX_RESULT_LIMIT}.`);
  }

  return ok({ bbox: boxCheck.value, statements, limit });
}

function parseStatement(line: string): ToolResult<QueryStatement> {
  if (!line.endsWith(";")) {
    return fail(`Each statement ends with a semicolon. This one does not: ${line}`);
  }
  const body = line.slice(0, -1);

  const selectorMatch = /^[a-z]+/.exec(body);
  const selector = selectorMatch?.[0] ?? "";
  if (!isSelector(selector)) {
    return fail(
      `\`${selector || line}\` is not a selector this tool accepts. Use node, way, relation or nwr. ` +
        "`area`, `is_in`, `rel`, recursion (`>`, `<`) and set variables are refused because they can " +
        "leave the bounding box.",
    );
  }

  const rest = body.slice(selector.length);
  if (rest.length === 0) {
    return fail(
      `\`${selector}\` on its own would return every element in the box. Add at least one ["key"="value"] filter.`,
    );
  }

  // Reconstruct from the matches and compare: anything the filter pattern did not consume —
  // an `(around:500)`, a `(51,0,52,1)` bbox, a `->.set`, a regex `~` — survives the
  // subtraction and the statement is refused. This is the check that makes the grammar a
  // whitelist rather than a set of hopeful regexes.
  const filters: TagFilter[] = [];
  let consumed = "";
  FILTER_PATTERN.lastIndex = 0;
  for (let match = FILTER_PATTERN.exec(rest); match !== null; match = FILTER_PATTERN.exec(rest)) {
    consumed += match[0];
    const key = match[1] ?? "";
    const operator = match[2];
    const value = match[3];

    if (!isValidTagKey(key)) {
      return fail(
        `\`${key}\` is not a tag key this tool accepts. Keys are letters, digits, underscores and colons.`,
      );
    }
    if (operator === undefined) {
      filters.push({ key });
      continue;
    }
    if (value === undefined || !isValidTagValue(value)) {
      return fail(
        `\`${value ?? ""}\` is not a tag value this tool accepts. Values are letters, digits and ` +
          `_ : . / + - and spaces. Regular-expression matches (~) are refused: an unindexed regex over a ` +
          `whole box is exactly the expensive query the public servers ask callers not to send.`,
      );
    }
    filters.push({ key, value, negated: operator === "!=" });
  }

  if (consumed !== rest) {
    return fail(
      `\`${rest}\` contains something outside this tool's grammar. Only ["key"], ["key"="value"] and ` +
        `["key"!="value"] filters are accepted — no (around:), no explicit bounding box, no set ` +
        `variables. For those, run the query in overpass-turbo, which uses your own connection and ` +
        `your own rate limit rather than this server's.`,
    );
  }

  if (filters.length === 0) {
    return fail(`\`${line}\` has no usable filter.`);
  }
  if (filters.length > MAX_FILTERS_PER_STATEMENT) {
    return fail(`At most ${MAX_FILTERS_PER_STATEMENT} filters per statement.`);
  }

  return ok({ selector, filters });
}

/**
 * Parse, then re-emit. The round trip is the security property: whatever a reader typed,
 * what leaves is a string this module generated from a validated structure.
 */
export function canonicaliseQuery(text: string): ToolResult<string> {
  const parsed = parseGuardedQuery(text);
  if (!parsed.ok) return parsed;
  return ok(buildQuery(parsed.value));
}

/** The query a preset selection produces, before the reader edits it. */
export function queryFromPresets(
  presetIds: readonly string[],
  bbox: BoundingBox,
  limit: number = DEFAULT_RESULT_LIMIT,
): ToolResult<string> {
  const statements: QueryStatement[] = [];
  for (const id of presetIds) {
    const preset = findPreset(id);
    if (!preset) return fail(`Unknown feature type: ${id}`);
    statements.push(preset.statement);
  }
  if (statements.length === 0) {
    return fail("Choose at least one feature type.");
  }
  const boxCheck = checkBoundingBox(bbox);
  if (!boxCheck.ok) return boxCheck;

  return ok(
    buildQuery({
      bbox: boxCheck.value,
      statements: statements.slice(0, MAX_STATEMENTS),
      limit: Math.min(Math.max(1, Math.trunc(limit)), MAX_RESULT_LIMIT),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * The response
 * ------------------------------------------------------------------ */

/**
 * Overpass answers `out center` with a bare `lat`/`lon` on a node and a `center` object on a
 * way or relation. Both shapes are in one schema rather than two, because a union that fails
 * to match either is the case that must degrade rather than silently return zero features.
 *
 * `remark` IS THE FIELD THAT MATTERS MOST. Overpass returns **HTTP 200 with a `remark`
 * string** when a query times out or runs out of memory mid-execution, and the `elements`
 * array then holds whatever it managed before it stopped. A client that ignores `remark`
 * shows a partial result as if it were complete — the silent-incompleteness failure this
 * codebase has been bitten by three times already. It is surfaced, prominently.
 */
const elementSchema = z
  .object({
    type: z.string(),
    id: z.number(),
    lat: z.number().nullish(),
    lon: z.number().nullish(),
    center: z.object({ lat: z.number(), lon: z.number() }).nullish(),
    tags: z.record(z.string()).nullish(),
  })
  .passthrough();

export const overpassResponseSchema = z
  .object({
    version: z.union([z.number(), z.string()]).nullish(),
    generator: z.string().nullish(),
    osm3s: z
      .object({
        timestamp_osm_base: z.string().nullish(),
        copyright: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    elements: z.array(elementSchema),
    remark: z.string().nullish(),
  })
  .passthrough();

export interface OverpassFeature {
  /** `way/123456789` — the form OpenStreetMap's own URLs take. */
  readonly id: string;
  readonly type: string;
  readonly osmId: number;
  readonly latitude: number;
  readonly longitude: number;
  /** `name`, or the most descriptive tag present, or the element type. */
  readonly label: string;
  readonly tags: Readonly<Record<string, string>>;
  /** Deep link to the element on openstreetmap.org, for checking tags and edit history. */
  readonly osmUrl: string;
}

export interface OverpassResult {
  readonly features: readonly OverpassFeature[];
  /** How many elements the response carried, including ones with no usable position. */
  readonly elementCount: number;
  /** When the OSM database extract behind the answer was cut. Not when we asked. */
  readonly dataTimestamp: string | null;
  /**
   * The upstream's own warning, verbatim. Non-null means the result is INCOMPLETE and the
   * UI must say so before it renders a single row.
   */
  readonly remark: string | null;
  readonly copyright: string | null;
}

/**
 * The tags most likely to carry a human-readable name, in the order worth trying.
 * `name` first; `operator` and `ref` are what an unnamed mast or pylon actually carries.
 */
const LABEL_KEYS = ["name", "name:en", "official_name", "operator", "ref", "brand"] as const;

function labelFor(element: { type: string; id: number; tags?: Readonly<Record<string, string>> | null }): string {
  const tags = element.tags ?? {};
  for (const key of LABEL_KEYS) {
    const value = tags[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return `Unnamed ${element.type} ${element.id}`;
}

/**
 * Narrow the validated payload to what the table and the map render.
 *
 * Elements with no position are counted but not returned: a relation with no centre cannot
 * be plotted and cannot be checked against imagery, and `elementCount` keeps the difference
 * visible rather than quietly reporting a smaller number than the server sent.
 */
export function normaliseOverpass(raw: unknown): ToolResult<OverpassResult> {
  const parsed = overpassResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      "The Overpass server answered with something this tool does not recognise. The layer is " +
        "disabled rather than showing a half-parsed result.",
    );
  }

  const features: OverpassFeature[] = [];
  for (const element of parsed.data.elements) {
    const latitude = element.lat ?? element.center?.lat ?? null;
    const longitude = element.lon ?? element.center?.lon ?? null;
    if (typeof latitude !== "number" || typeof longitude !== "number") continue;

    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(element.tags ?? {})) {
      if (typeof value === "string") tags[key] = value;
    }

    features.push({
      id: `${element.type}/${element.id}`,
      type: element.type,
      osmId: element.id,
      latitude,
      longitude,
      label: labelFor({ type: element.type, id: element.id, tags }),
      tags,
      osmUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    });
  }

  return ok({
    features,
    elementCount: parsed.data.elements.length,
    dataTimestamp: parsed.data.osm3s?.timestamp_osm_base ?? null,
    remark: parsed.data.remark ?? null,
    copyright: parsed.data.osm3s?.copyright ?? null,
  });
}

/**
 * ODbL requires attribution and this is the string rendered next to the results, at the point
 * of display, never in a footer. A missing credit here is a licence breach, not a polish
 * defect — the same rule the source adapters follow.
 */
export const OSM_ATTRIBUTION = "Feature data © OpenStreetMap contributors, ODbL 1.0";
export const OSM_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";

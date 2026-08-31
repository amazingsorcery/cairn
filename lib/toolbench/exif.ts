/**
 * Turning `exifr`'s output into something a reader can audit.
 *
 * `exifr` hands back a plain object whose shape depends on what the file happens to contain,
 * so everything below narrows from `unknown`. A tag's value can be a string, a number, a
 * `Date`, an array of rationals, or a byte array, and a viewer that assumes otherwise
 * crashes on the first unusual camera it meets.
 *
 * The interpretation rules that matter, which the tool page repeats:
 *
 *   - **Metadata is a claim, not a fact.** Every field here can be written by hand in
 *     seconds. A GPS fix is a hypothesis to confirm against the picture, never an answer.
 *   - **Absence proves nothing.** Every major platform strips EXIF on upload. A file with no
 *     metadata is overwhelmingly likely to have come through one, not to have been cleaned.
 *   - **A camera clock is only as good as whoever set it.** Unset clocks, wrong zones and
 *     drift are ordinary. `DateTimeOriginal` carries no zone at all unless the camera also
 *     wrote `OffsetTimeOriginal`, which most do not.
 */

export type MetadataScalar = string | number | boolean | null;

export interface MetadataEntry {
  readonly key: string;
  /** Rendered for display. Never `[object Object]`, never a raw byte dump. */
  readonly value: string;
  /** True where the value was too large or too binary to show in full. */
  readonly summarised: boolean;
}

export interface MetadataBlock {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly entries: readonly MetadataEntry[];
}

const BLOCK_LABELS: Readonly<Record<string, { label: string; description: string }>> = {
  ifd0: {
    label: "IFD0 — image",
    description:
      "The main TIFF directory: camera make and model, orientation, resolution, and the software string that most often reveals an editor.",
  },
  exif: {
    label: "EXIF — capture",
    description:
      "What the camera recorded at the moment of exposure: timestamps, shutter, aperture, ISO, lens, and the flags a device sets for its own processing.",
  },
  gps: {
    label: "GPS",
    description:
      "Where the device believed it was. A fix, not a fact — trivially forged, and often simply wrong indoors or in cities.",
  },
  interop: { label: "Interoperability", description: "The IFD that declares which EXIF profile the file follows." },
  iptc: {
    label: "IPTC",
    description:
      "The newsroom fields: caption, credit, byline, city and country. Written by people rather than by cameras, so they carry intent.",
  },
  xmp: {
    label: "XMP",
    description:
      "Adobe's metadata block. Frequently contains an edit history, a creator tool, and a second copy of fields that appear elsewhere — a disagreement between the two copies is worth reading.",
  },
  icc: { label: "ICC profile", description: "The colour profile, which identifies the software or device that wrote it." },
  jfif: { label: "JFIF", description: "The JPEG container header: version and pixel density." },
  ihdr: { label: "IHDR", description: "The PNG image header: dimensions, bit depth and colour type." },
  thumbnail: { label: "Thumbnail IFD", description: "The directory describing the embedded preview image." },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Render one tag value for display, narrowing from `unknown` at every step. */
export function renderValue(value: unknown): { text: string; summarised: boolean } {
  if (value === null || value === undefined) return { text: "(empty)", summarised: false };
  if (value instanceof Date) {
    return {
      text: Number.isNaN(value.getTime()) ? "(unreadable date)" : value.toISOString(),
      summarised: false,
    };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const length = value instanceof Uint8Array ? value.length : value.byteLength;
    return { text: `binary, ${length} bytes`, summarised: true };
  }
  if (Array.isArray(value)) {
    const rendered = value.slice(0, 8).map((item) => renderValue(item).text);
    const suffix = value.length > 8 ? `, ... (${value.length} values)` : "";
    return { text: `${rendered.join(", ")}${suffix}`, summarised: value.length > 8 };
  }
  if (typeof value === "string") {
    const trimmed = value.replace(/\0+$/, "").trim();
    if (trimmed.length === 0) return { text: "(empty)", summarised: false };
    return trimmed.length > 400
      ? { text: `${trimmed.slice(0, 400)}...`, summarised: true }
      : { text: trimmed, summarised: false };
  }
  if (typeof value === "number") {
    return { text: Number.isFinite(value) ? String(value) : "(not a number)", summarised: false };
  }
  if (typeof value === "boolean") return { text: value ? "true" : "false", summarised: false };
  if (isRecord(value)) {
    const json = JSON.stringify(value);
    return json.length > 400
      ? { text: `${json.slice(0, 400)}...`, summarised: true }
      : { text: json, summarised: false };
  }
  return { text: "(unreadable value)", summarised: true };
}

/**
 * Group `exifr`'s segmented output into displayable blocks.
 *
 * Expects the result of a parse with `mergeOutput: false`, which keeps the segments apart.
 * Merging them is convenient and destroys the most useful signal in the file: which block a
 * value came from, and whether two blocks disagree.
 */
export function normaliseMetadata(raw: unknown): readonly MetadataBlock[] {
  if (!isRecord(raw)) return [];
  const blocks: MetadataBlock[] = [];

  for (const [id, contents] of Object.entries(raw)) {
    if (!isRecord(contents)) continue;
    const entries: MetadataEntry[] = [];
    for (const [key, value] of Object.entries(contents)) {
      const rendered = renderValue(value);
      entries.push({ key, value: rendered.text, summarised: rendered.summarised });
    }
    if (entries.length === 0) continue;
    const label = BLOCK_LABELS[id];
    blocks.push({
      id,
      label: label?.label ?? id,
      description: label?.description ?? "A metadata block this viewer has no description for.",
      entries: entries.sort((a, b) => a.key.localeCompare(b.key)),
    });
  }

  return blocks.sort((a, b) => a.id.localeCompare(b.id));
}

export interface GpsFix {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitudeMetres: number | null;
  /** Where the camera was pointed, degrees clockwise from north. Rarely present. */
  readonly imageDirectionDegrees: number | null;
  /** `T` for true north, `M` for magnetic. Magnetic bearings need a declination correction. */
  readonly directionReference: string | null;
}

function numberAt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pull a coordinate out of whichever block holds one.
 *
 * `exifr` computes decimal `latitude` and `longitude` when it can. Where it cannot — an
 * unusual writer, a partial block — the raw `GPSLatitude` degrees/minutes/seconds triple and
 * its N/S reference are converted here rather than being dropped.
 */
export function extractGps(raw: unknown): GpsFix | null {
  if (!isRecord(raw)) return null;
  const gps = isRecord(raw["gps"]) ? raw["gps"] : raw;

  let latitude = numberAt(gps, "latitude");
  let longitude = numberAt(gps, "longitude");

  if (latitude === null || longitude === null) {
    const fromParts = (parts: unknown, reference: string | null): number | null => {
      if (!Array.isArray(parts)) return null;
      const [degrees, minutes, seconds] = parts;
      if (typeof degrees !== "number") return null;
      const magnitude =
        degrees +
        (typeof minutes === "number" ? minutes / 60 : 0) +
        (typeof seconds === "number" ? seconds / 3600 : 0);
      const negative = reference === "S" || reference === "W";
      return negative ? -magnitude : magnitude;
    };
    latitude = latitude ?? fromParts(gps["GPSLatitude"], stringAt(gps, "GPSLatitudeRef"));
    longitude = longitude ?? fromParts(gps["GPSLongitude"], stringAt(gps, "GPSLongitudeRef"));
  }

  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    altitudeMetres: numberAt(gps, "GPSAltitude") ?? numberAt(gps, "altitude"),
    imageDirectionDegrees: numberAt(gps, "GPSImgDirection"),
    directionReference: stringAt(gps, "GPSImgDirectionRef"),
  };
}

export type FindingSeverity = "info" | "notable";

export interface MetadataFinding {
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
}

/** Software strings that indicate the file passed through an editor rather than a camera. */
const EDITOR_SIGNATURES = [
  "photoshop",
  "lightroom",
  "gimp",
  "affinity",
  "paint.net",
  "pixelmator",
  "snapseed",
  "picasa",
  "capture one",
  "darktable",
  "luminar",
  "canva",
  "figma",
  "imagemagick",
  "ffmpeg",
] as const;

function findEntry(blocks: readonly MetadataBlock[], key: string): string | null {
  for (const block of blocks) {
    for (const entry of block.entries) {
      if (entry.key.toLowerCase() === key.toLowerCase()) return entry.value;
    }
  }
  return null;
}

/**
 * Things worth pointing at, each phrased so that the reader does the concluding.
 *
 * This is not a verdict engine. Every item is a description of what is in the file plus what
 * would ordinarily produce it, and none of them is evidence of manipulation on its own.
 */
export function analyseMetadata(
  blocks: readonly MetadataBlock[],
  gps: GpsFix | null,
): readonly MetadataFinding[] {
  const findings: MetadataFinding[] = [];

  if (blocks.length === 0) {
    findings.push({
      severity: "info",
      title: "No metadata at all",
      detail:
        "The file carries no EXIF, IPTC or XMP. This is the normal state of an image downloaded from any major platform — all of them strip metadata on upload — so it is evidence of a platform in the chain, not of deliberate cleaning. Ask the source for the file straight off the device.",
    });
    return findings;
  }

  const software = findEntry(blocks, "Software") ?? findEntry(blocks, "CreatorTool") ?? findEntry(blocks, "ProcessingSoftware");
  if (software !== null) {
    const matched = EDITOR_SIGNATURES.find((name) => software.toLowerCase().includes(name));
    findings.push({
      severity: matched === undefined ? "info" : "notable",
      title: `Written by "${software}"`,
      detail:
        matched === undefined
          ? "This is usually the camera's own firmware string. Compare it against the make and model: a mismatch is worth a question."
          : "That is an image editor, so the file has been through one. Editing is not falsification — every published photograph is edited — but it means the file is not the camera original, and the original is what you should ask for.",
    });
  }

  const original = findEntry(blocks, "DateTimeOriginal");
  const modified = findEntry(blocks, "ModifyDate");
  if (original !== null && modified !== null && original !== modified) {
    findings.push({
      severity: "notable",
      title: "Capture time and modification time disagree",
      detail: `DateTimeOriginal is ${original} and ModifyDate is ${modified}. Something wrote to the file after it was taken. In-camera processing does this routinely, so the gap matters more than its existence: minutes are unremarkable, months are a question.`,
    });
  }

  if (original !== null && findEntry(blocks, "OffsetTimeOriginal") === null) {
    findings.push({
      severity: "info",
      title: "The capture time carries no time zone",
      detail:
        "EXIF timestamps are wall-clock readings from the camera's own clock, with no zone unless the camera also wrote OffsetTimeOriginal. Treating this as UTC, or as your own local time, is how a timeline ends up hours out.",
    });
  }

  if (gps !== null) {
    findings.push({
      severity: "notable",
      title: "The file carries a GPS fix",
      detail: `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}. Confirm it against the picture before relying on it: the tag is trivially editable, a phone indoors can be hundreds of metres out, and a suspiciously precise fix on an otherwise stripped file is a reason for more suspicion, not less.`,
    });
    if (gps.imageDirectionDegrees !== null) {
      findings.push({
        severity: "info",
        title: `Camera bearing recorded: ${gps.imageDirectionDegrees.toFixed(1)} degrees`,
        detail:
          gps.directionReference === "M"
            ? "Magnetic north. Correct for the local declination before comparing it against a map bearing or a sun azimuth."
            : "True north, if the reference field is to be believed. This constrains what should be visible in the frame, which is a check you can run against satellite imagery.",
      });
    }
  }

  const make = findEntry(blocks, "Make");
  const model = findEntry(blocks, "Model");
  if (make !== null || model !== null) {
    findings.push({
      severity: "info",
      title: `Device claimed: ${[make, model].filter((part) => part !== null).join(" ")}`,
      detail:
        "Check this against what the source says they used. A mismatch is one of the cheapest inconsistencies to find and one of the hardest to explain away.",
    });
  }

  return findings;
}

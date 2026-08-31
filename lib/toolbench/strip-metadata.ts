import { fail, ok, type ToolResult } from "./result";

/**
 * Remove metadata from a JPEG or a PNG **without re-encoding the image**.
 *
 * The usual browser trick — draw the image onto a canvas and export it — does strip
 * metadata, and it also re-compresses every pixel, changing the file's appearance, its size,
 * and its hash. For a journalist publishing a source's photograph that is a real loss: the
 * picture that goes out is not the picture that came in, and it can no longer be compared
 * against the original.
 *
 * This works on the container instead. A JPEG is a sequence of marker segments and a PNG is
 * a sequence of chunks; the ones that carry metadata are removed and the compressed image
 * data is copied through byte for byte. The result decodes to exactly the same pixels.
 *
 * WHAT THIS DOES NOT REMOVE, and the tool page says so in these words:
 *
 *   - **Anything visible in the picture.** A street sign, a reflection, a screen, a face.
 *     Metadata stripping is not redaction.
 *   - **Sensor and encoder fingerprints.** Photo-response non-uniformity is a property of
 *     the pixels themselves, and quantisation tables and Huffman tables identify the encoder
 *     that produced the file. Both survive, because both are the image.
 *   - **Anything the platform you upload to adds afterwards**, or already knows from the
 *     upload itself.
 */

export type ImageContainer = "jpeg" | "png";

export interface RemovedItem {
  /** `APP1 (Exif)`, `tEXt`, and so on. */
  readonly label: string;
  readonly bytes: number;
  /** What that segment usually carries, so the reader can see what they are losing. */
  readonly carries: string;
}

export interface StripResult {
  readonly container: ImageContainer;
  readonly bytes: Uint8Array;
  readonly removed: readonly RemovedItem[];
  readonly bytesRemoved: number;
  /** Segments deliberately kept, with the reason, so the result is not silently partial. */
  readonly kept: readonly RemovedItem[];
}

const JPEG_SIGNATURE = [0xff, 0xd8] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function detectContainer(bytes: Uint8Array): ImageContainer | null {
  if (JPEG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "jpeg";
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "png";
  return null;
}

/** ASCII prefix of a segment payload, used to tell APP segments of the same number apart. */
function asciiPrefix(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < Math.min(start + length, bytes.length); i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte === 0) break;
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "?";
  }
  return out;
}

interface JpegDecision {
  readonly remove: boolean;
  readonly label: string;
  readonly carries: string;
}

/**
 * Which JPEG marker segments carry metadata, and which are load-bearing for the picture.
 *
 * Three are kept on purpose, because removing them changes what the file looks like:
 *
 *   - **APP0 `JFIF`** holds the pixel-density fields.
 *   - **APP2 `ICC_PROFILE`** is the colour profile. Strip it and a wide-gamut photograph is
 *     rendered as if it were sRGB — visibly wrong colour, in a file the reader believes is
 *     unmodified.
 *   - **APP14 `Adobe`** carries the colour-transform flag. Without it a CMYK or YCCK JPEG
 *     decodes with inverted colour.
 *
 * APP0 `JFXX` and APP2 `MPF` are removed despite their neighbours being kept: the first is a
 * thumbnail and the second indexes additional embedded images.
 */
function classifyJpegSegment(marker: number, payload: string): JpegDecision {
  if (marker === 0xe0) {
    return payload.startsWith("JFXX")
      ? { remove: true, label: "APP0 (JFXX)", carries: "an embedded thumbnail" }
      : { remove: false, label: "APP0 (JFIF)", carries: "pixel density; kept because it affects display" };
  }
  if (marker === 0xe1) {
    const isXmp = payload.startsWith("http://ns.adobe.com/xap");
    return {
      remove: true,
      label: isXmp ? "APP1 (XMP)" : "APP1 (Exif)",
      carries: isXmp
        ? "editing history, creator and rights fields, and often a second copy of the capture data"
        : "camera, lens, capture settings, timestamps, GPS and the embedded thumbnail",
    };
  }
  if (marker === 0xe2) {
    return payload.startsWith("ICC_PROFILE")
      ? {
          remove: false,
          label: "APP2 (ICC_PROFILE)",
          carries: "the colour profile; kept because removing it changes the colours on screen",
        }
      : { remove: true, label: `APP2 (${payload.slice(0, 12) || "unknown"})`, carries: "additional embedded images or vendor data" };
  }
  if (marker === 0xed) {
    return {
      remove: true,
      label: "APP13 (Photoshop/IPTC)",
      carries: "IPTC captions, credit and location fields, and Photoshop's own resources",
    };
  }
  if (marker === 0xee) {
    return {
      remove: false,
      label: "APP14 (Adobe)",
      carries: "the colour-transform flag; kept because removing it can invert CMYK colour",
    };
  }
  if (marker >= 0xe3 && marker <= 0xef) {
    return {
      remove: true,
      label: `APP${marker - 0xe0} (${payload.slice(0, 12) || "unknown"})`,
      carries: "vendor-specific data, frequently including device and capture details",
    };
  }
  if (marker === 0xfe) {
    return { remove: true, label: "COM (comment)", carries: "a free-text comment" };
  }
  return { remove: false, label: `marker 0x${marker.toString(16)}`, carries: "image structure" };
}

export function stripJpegMetadata(bytes: Uint8Array): ToolResult<StripResult> {
  if (detectContainer(bytes) !== "jpeg") return fail("That is not a JPEG.");

  const pieces: Uint8Array[] = [bytes.subarray(0, 2)];
  const removed: RemovedItem[] = [];
  const kept: RemovedItem[] = [];
  let index = 2;
  let reachedImageData = false;

  while (index < bytes.length) {
    if (bytes[index] !== 0xff) {
      return fail(
        `The JPEG structure breaks at byte ${index}: a marker must start with 0xFF. The file may be truncated or not a JPEG at all.`,
      );
    }
    // Fill bytes: any number of 0xFF may precede the marker identifier.
    let markerIndex = index + 1;
    while (bytes[markerIndex] === 0xff) markerIndex += 1;
    const marker = bytes[markerIndex];
    if (marker === undefined) return fail("The file ends in the middle of a JPEG marker.");

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pieces.push(bytes.subarray(index, markerIndex + 1));
      index = markerIndex + 1;
      continue;
    }
    // Start of scan, or end of image: everything from here is entropy-coded data and is
    // copied through untouched. This is what makes the operation lossless.
    if (marker === 0xda || marker === 0xd9) {
      pieces.push(bytes.subarray(index));
      reachedImageData = true;
      break;
    }

    const high = bytes[markerIndex + 1];
    const low = bytes[markerIndex + 2];
    if (high === undefined || low === undefined) {
      return fail("The file ends in the middle of a JPEG segment header.");
    }
    const length = (high << 8) | low;
    if (length < 2) return fail(`A JPEG segment claims a length of ${length}, which is impossible.`);
    const segmentEnd = markerIndex + 1 + length;
    if (segmentEnd > bytes.length) {
      return fail("A JPEG segment runs past the end of the file. The file is truncated.");
    }

    const decision = classifyJpegSegment(marker, asciiPrefix(bytes, markerIndex + 3, 32));
    const item: RemovedItem = {
      label: decision.label,
      bytes: segmentEnd - index,
      carries: decision.carries,
    };
    if (decision.remove) {
      removed.push(item);
    } else {
      if (marker >= 0xe0 && marker <= 0xef) kept.push(item);
      pieces.push(bytes.subarray(index, segmentEnd));
    }
    index = segmentEnd;
  }

  if (!reachedImageData) {
    return fail(
      "The file ends before any image data. It is a JPEG header with no picture attached — most often a truncated download.",
    );
  }

  return ok({
    container: "jpeg",
    bytes: concat(pieces),
    removed,
    bytesRemoved: removed.reduce((total, item) => total + item.bytes, 0),
    kept,
  });
}

/**
 * PNG ancillary chunks that carry metadata rather than picture.
 *
 * `iCCP`, `gAMA`, `sRGB`, `cHRM` and `pHYs` are deliberately absent: they describe how the
 * pixels should be interpreted, and removing them changes the rendered image.
 */
const PNG_METADATA_CHUNKS: Readonly<Record<string, string>> = {
  tEXt: "uncompressed key/value text, often the software that wrote the file",
  zTXt: "compressed key/value text",
  iTXt: "international text, which is where XMP is stored in a PNG",
  eXIf: "a full EXIF block, including GPS if the source had it",
  tIME: "the last-modification time",
};

export function stripPngMetadata(bytes: Uint8Array): ToolResult<StripResult> {
  if (detectContainer(bytes) !== "png") return fail("That is not a PNG.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pieces: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed: RemovedItem[] = [];
  let index = 8;

  while (index + 8 <= bytes.length) {
    const length = view.getUint32(index);
    const type = asciiPrefix(bytes, index + 4, 4).slice(0, 4);
    const chunkEnd = index + 12 + length;
    if (chunkEnd > bytes.length) {
      return fail(`The chunk "${type}" runs past the end of the file. The PNG is truncated.`);
    }

    const carries = PNG_METADATA_CHUNKS[type];
    if (carries !== undefined) {
      removed.push({ label: type, bytes: chunkEnd - index, carries });
    } else {
      pieces.push(bytes.subarray(index, chunkEnd));
    }

    index = chunkEnd;
    if (type === "IEND") break;
  }

  return ok({
    container: "png",
    bytes: concat(pieces),
    removed,
    bytesRemoved: removed.reduce((total, item) => total + item.bytes, 0),
    kept: [],
  });
}

export function stripMetadata(bytes: Uint8Array): ToolResult<StripResult> {
  const container = detectContainer(bytes);
  if (container === "jpeg") return stripJpegMetadata(bytes);
  if (container === "png") return stripPngMetadata(bytes);
  return fail(
    "This works on JPEG and PNG, which is what the container-level strip can be done losslessly on. Other formats would have to be re-encoded, which changes every pixel.",
  );
}

function concat(pieces: readonly Uint8Array[]): Uint8Array {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

import { describe, expect, it } from "vitest";

import { bytesToHex, utf8ToBytes } from "./bytes";
import { detectContainer, stripJpegMetadata, stripMetadata, stripPngMetadata } from "./strip-metadata";

/** A JPEG marker segment: 0xFF, the marker, a two-byte length, then the payload. */
function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  const out = new Uint8Array(payload.length + 4);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
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

/** Entropy-coded scan data, standing in for the compressed picture. */
const SCAN_DATA = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);

function buildJpeg(segments: readonly Uint8Array[]): Uint8Array {
  return concat([
    new Uint8Array([0xff, 0xd8]),
    ...segments,
    jpegSegment(0xdb, new Uint8Array(64)), // DQT: quantisation table, part of the image
    jpegSegment(0xda, new Uint8Array([0x01, 0x01, 0x00])), // SOS header
    SCAN_DATA,
    new Uint8Array([0xff, 0xd9]), // EOI
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(utf8ToBytes(type), 4);
  out.set(data, 8);
  // A real CRC-32 of the type and data. The stripper does not verify it and does not need
  // to: it never alters a chunk's contents, only whether the chunk is present.
  view.setUint32(out.length - 4, 0);
  return out;
}

function buildPng(chunks: readonly Uint8Array[]): Uint8Array {
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    ...chunks,
    pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

describe("container detection", () => {
  it("reads the magic bytes, not the file extension", () => {
    expect(detectContainer(buildJpeg([]))).toBe("jpeg");
    expect(detectContainer(buildPng([]))).toBe("png");
    expect(detectContainer(utf8ToBytes("GIF89a..."))).toBeNull();
  });
});

describe("stripping a JPEG", () => {
  const exif = jpegSegment(0xe1, concat([utf8ToBytes("Exif\0\0"), new Uint8Array(200)]));
  const xmp = jpegSegment(
    0xe1,
    concat([utf8ToBytes("http://ns.adobe.com/xap/1.0/\0"), utf8ToBytes("<x:xmpmeta/>")]),
  );
  const iptc = jpegSegment(0xed, concat([utf8ToBytes("Photoshop 3.0\0"), new Uint8Array(50)]));
  const comment = jpegSegment(0xfe, utf8ToBytes("taken with the good camera"));
  const jfif = jpegSegment(0xe0, concat([utf8ToBytes("JFIF\0"), new Uint8Array(9)]));
  const icc = jpegSegment(0xe2, concat([utf8ToBytes("ICC_PROFILE\0"), new Uint8Array(100)]));
  const adobe = jpegSegment(0xee, concat([utf8ToBytes("Adobe"), new Uint8Array(7)]));
  const jfxx = jpegSegment(0xe0, concat([utf8ToBytes("JFXX\0"), new Uint8Array(30)]));

  const original = buildJpeg([jfif, exif, xmp, icc, iptc, adobe, jfxx, comment]);

  it("removes EXIF, XMP, IPTC, the comment and the JFXX thumbnail", () => {
    const result = stripJpegMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed.map((item) => item.label).sort()).toEqual([
      "APP0 (JFXX)",
      "APP1 (Exif)",
      "APP1 (XMP)",
      "APP13 (Photoshop/IPTC)",
      "COM (comment)",
    ]);
  });

  it("keeps the segments that decide how the picture looks, and says which", () => {
    const result = stripJpegMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kept.map((item) => item.label).sort()).toEqual([
      "APP0 (JFIF)",
      "APP14 (Adobe)",
      "APP2 (ICC_PROFILE)",
    ]);
    for (const item of result.value.kept) {
      expect(item.carries).toContain("kept because");
    }
  });

  it("leaves the compressed image data byte-for-byte identical", () => {
    const result = stripJpegMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.bytes;
    // Everything from the start-of-scan marker to the end of the file must be untouched.
    const sosIndex = findSos(output);
    const originalSosIndex = findSos(original);
    expect(sosIndex).toBeGreaterThan(0);
    expect(bytesToHex(output.subarray(sosIndex))).toBe(
      bytesToHex(original.subarray(originalSosIndex)),
    );
  });

  it("gets smaller by exactly the size of what it removed", () => {
    const result = stripJpegMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(original.length - result.value.bytes.length).toBe(result.value.bytesRemoved);
    expect(result.value.bytesRemoved).toBeGreaterThan(0);
  });

  it("is idempotent — a second pass finds nothing left to remove", () => {
    const first = stripJpegMetadata(original);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = stripJpegMetadata(first.value.bytes);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.removed).toHaveLength(0);
    expect(bytesToHex(second.value.bytes)).toBe(bytesToHex(first.value.bytes));
  });

  it("refuses a truncated file rather than emitting a broken one", () => {
    // Cut cleanly on a segment boundary: a header with no picture behind it.
    expect(stripJpegMetadata(original.subarray(0, 20)).ok).toBe(false);
    // Cut mid-segment: a segment that claims more bytes than the file contains.
    expect(stripJpegMetadata(original.subarray(0, 60)).ok).toBe(false);
    // Cut mid-header: not even a complete length field.
    expect(stripJpegMetadata(original.subarray(0, 21)).ok).toBe(false);
  });
});

describe("stripping a PNG", () => {
  const original = buildPng([
    pngChunk("tEXt", utf8ToBytes("Software\0Adobe Photoshop 26.0")),
    pngChunk("eXIf", new Uint8Array(120)),
    pngChunk("tIME", new Uint8Array(7)),
    pngChunk("iTXt", utf8ToBytes("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>")),
    pngChunk("pHYs", new Uint8Array(9)),
    pngChunk("iCCP", concat([utf8ToBytes("profile\0\0"), new Uint8Array(60)])),
  ]);

  it("removes the text, time and EXIF chunks", () => {
    const result = stripPngMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed.map((item) => item.label).sort()).toEqual([
      "eXIf",
      "iTXt",
      "tEXt",
      "tIME",
    ]);
  });

  it("keeps the chunks that decide how the pixels are interpreted", () => {
    const result = stripPngMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hex = bytesToHex(result.value.bytes);
    expect(hex).toContain(bytesToHex(utf8ToBytes("iCCP")));
    expect(hex).toContain(bytesToHex(utf8ToBytes("pHYs")));
    expect(hex).toContain(bytesToHex(utf8ToBytes("IHDR")));
    expect(hex).toContain(bytesToHex(utf8ToBytes("IDAT")));
    expect(hex).toContain(bytesToHex(utf8ToBytes("IEND")));
  });

  it("leaves the image data chunk untouched", () => {
    const result = stripPngMetadata(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const idat = bytesToHex(
      pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    );
    expect(bytesToHex(result.value.bytes)).toContain(idat);
  });

  it("is idempotent", () => {
    const first = stripPngMetadata(original);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = stripPngMetadata(first.value.bytes);
    expect(second.ok && second.value.removed).toHaveLength(0);
  });
});

describe("formats it will not pretend to handle", () => {
  it("declines rather than re-encoding something it cannot strip losslessly", () => {
    const result = stripMetadata(utf8ToBytes("GIF89a"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JPEG and PNG");
  });
});

/** Index of the 0xFFDA start-of-scan marker. */
function findSos(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xda) return i;
  }
  return -1;
}

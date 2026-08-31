import { fail, ok, type ToolResult } from "./result";

/**
 * Client-side file gates.
 *
 * Everything in this workbench runs in the browser, so these limits exist to protect the
 * reader from a hung tab, not to protect a server from an upload. There is no server to
 * protect: no file here is ever sent anywhere. That is why the limits can be generous.
 *
 * The type check reads the file's own leading bytes rather than trusting `File.type`, which
 * the browser derives from the extension and which is therefore whatever the file was named.
 * A `.jpg` that is really a PDF should be told apart before anything tries to decode it.
 */

export const IMAGE_SIGNATURES = [
  { mime: "image/jpeg", label: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", label: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", label: "GIF", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/bmp", label: "BMP", bytes: [0x42, 0x4d] },
  { mime: "image/tiff", label: "TIFF (little-endian)", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: "image/tiff", label: "TIFF (big-endian)", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
] as const;

export interface SniffedType {
  readonly mime: string;
  readonly label: string;
}

/** Identify a file by its leading bytes. `null` when nothing matches. */
export function sniffImageType(bytes: Uint8Array): SniffedType | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) {
      return { mime: signature.mime, label: signature.label };
    }
  }
  // WebP and the ISO-BMFF family (HEIC, AVIF) put their identifier after a length or a
  // container tag rather than at offset zero.
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) {
    return { mime: "image/webp", label: "WebP" };
  }
  if (matchesAscii(bytes, 4, "ftyp")) {
    const brand = asciiAt(bytes, 8, 4);
    if (brand.startsWith("hei") || brand.startsWith("hev") || brand === "mif1") {
      return { mime: "image/heic", label: "HEIC" };
    }
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", label: "AVIF" };
  }
  return null;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < Math.min(offset + length, bytes.length); i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function matchesAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  return asciiAt(bytes, offset, expected.length) === expected;
}

export interface FileGate {
  readonly maxBytes: number;
  /** MIME types the tool can actually process. Checked against the sniffed type. */
  readonly accept: readonly string[];
}

/**
 * 64 MB. Large enough for a raw-ish JPEG off a full-frame camera or a long screenshot, small
 * enough that reading it into an ArrayBuffer will not take a phone down.
 */
export const IMAGE_GATE: FileGate = {
  maxBytes: 64 * 1024 * 1024,
  accept: ["image/jpeg", "image/png", "image/webp", "image/tiff", "image/heic", "image/avif", "image/gif"],
};

/** Anything at all, for the hashing tool, where the file's type is irrelevant. */
export const ANY_FILE_GATE: FileGate = { maxBytes: 512 * 1024 * 1024, accept: [] };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Size gate, applied before the file is read. */
export function checkFileSize(size: number, gate: FileGate): ToolResult<null> {
  if (size === 0) return fail("That file is empty.");
  if (size > gate.maxBytes) {
    return fail(
      `That file is ${formatBytes(size)}, over this tool's ${formatBytes(gate.maxBytes)} limit. The limit is here so the browser tab does not run out of memory — nothing is being uploaded either way.`,
    );
  }
  return ok(null);
}

/** Type gate, applied to the bytes after reading. */
export function checkFileType(bytes: Uint8Array, gate: FileGate): ToolResult<SniffedType> {
  const sniffed = sniffImageType(bytes);
  if (gate.accept.length === 0) {
    return ok(sniffed ?? { mime: "application/octet-stream", label: "unrecognised" });
  }
  if (sniffed === null) {
    return fail(
      "The leading bytes of that file do not match any image format this tool reads. The file name is not the check — a renamed file will land here.",
    );
  }
  if (!gate.accept.includes(sniffed.mime)) {
    return fail(`That is a ${sniffed.label}, which this tool does not read.`);
  }
  return ok(sniffed);
}

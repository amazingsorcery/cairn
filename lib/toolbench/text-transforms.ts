import { fail, ok, type ToolResult } from "./result";

/**
 * Reversible text transforms: URL encoding, ROT-n and XOR.
 *
 * None of these is encryption and the UI must not imply otherwise. ROT-n and a repeating-key
 * XOR are obfuscation: they appear constantly in malware configuration blobs, phishing kits
 * and lazily "hidden" strings, which is why an investigator needs them, and they offer no
 * confidentiality whatsoever.
 */

export type UrlEncodingMode = "component" | "uri" | "form";

/**
 * `component` escapes everything a value may not contain (`encodeURIComponent`).
 * `uri` preserves the reserved characters that give a URL its structure (`encodeURI`).
 * `form` is `application/x-www-form-urlencoded`: like `component`, but a space is `+`.
 */
export function urlEncode(text: string, mode: UrlEncodingMode = "component"): string {
  if (mode === "uri") return encodeURI(text);
  const encoded = encodeURIComponent(text);
  return mode === "form" ? encoded.replace(/%20/g, "+") : encoded;
}

export function urlDecode(text: string, mode: UrlEncodingMode = "component"): ToolResult<string> {
  const prepared = mode === "form" ? text.replace(/\+/g, "%20") : text;
  try {
    return ok(mode === "uri" ? decodeURI(prepared) : decodeURIComponent(prepared));
  } catch {
    return fail("That is not valid percent-encoding — a % must be followed by two hex digits.");
  }
}

const UPPER_A = 65;
const LOWER_A = 97;

/**
 * Caesar shift over the 26 ASCII letters. Everything else — digits, punctuation, accented
 * letters, emoji — passes through untouched, which is the behaviour that makes the classic
 * ROT13 identity hold.
 */
export function rotN(text: string, shift: number): string {
  const n = ((Math.trunc(shift) % 26) + 26) % 26;
  if (n === 0) return text;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code >= UPPER_A && code <= UPPER_A + 25) {
      out += String.fromCodePoint(((code - UPPER_A + n) % 26) + UPPER_A);
    } else if (code >= LOWER_A && code <= LOWER_A + 25) {
      out += String.fromCodePoint(((code - LOWER_A + n) % 26) + LOWER_A);
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * ROT47 rotates the 94 printable ASCII characters from `!` (33) to `~` (126), so unlike
 * ROT-n it also moves digits and punctuation. It is its own inverse. Included because it
 * turns up in obfuscated shell one-liners often enough to be worth the eight lines.
 */
export function rot47(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    out += code >= 33 && code <= 126 ? String.fromCodePoint(33 + ((code - 33 + 47) % 94)) : char;
  }
  return out;
}

/** Repeating-key XOR. Symmetric, so the same call decodes. */
export function xorBytes(data: Uint8Array, key: Uint8Array): ToolResult<Uint8Array> {
  if (key.length === 0) return fail("A XOR key must be at least one byte.");
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = (data[i] ?? 0) ^ (key[i % key.length] ?? 0);
  }
  return ok(out);
}

/**
 * Single-byte XOR brute force: all 255 non-identity keys, ranked by how much of the output
 * looks like printable text. This is the standard first move against an obfuscated blob and
 * it is cheap, so the tool offers it rather than making the reader try keys by hand.
 *
 * The score is the share of bytes that are printable ASCII, tab, newline or carriage return.
 * It ranks candidates; it does not decide. A high score on short input means very little,
 * and on compressed or genuinely binary plaintext the correct key will not rank first.
 */
export interface XorCandidate {
  readonly key: number;
  readonly printableRatio: number;
  readonly preview: string;
}

export function bruteForceSingleByteXor(data: Uint8Array, limit = 10): readonly XorCandidate[] {
  const candidates: XorCandidate[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let key = 1; key <= 255; key += 1) {
    let printable = 0;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const byte = (data[i] ?? 0) ^ key;
      out[i] = byte;
      if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
        printable += 1;
      }
    }
    candidates.push({
      key,
      printableRatio: data.length === 0 ? 0 : printable / data.length,
      preview: decoder.decode(out.subarray(0, 120)),
    });
  }
  return candidates.sort((a, b) => b.printableRatio - a.printableRatio).slice(0, limit);
}

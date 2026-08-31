import { fail, ok, type ToolResult } from "./result";

/**
 * Byte-level encodings: hex, base64 (both alphabets) and base32 (RFC 4648).
 *
 * Written by hand rather than delegated to `atob`/`btoa` or Node's `Buffer` for three
 * reasons that matter for an investigative tool:
 *
 *   1. `atob` operates on a "binary string" whose code units above 0xFF throw, so any
 *      non-ASCII input has to be laundered through a second encoding first. That laundering
 *      is where round-trips silently stop being byte-exact.
 *   2. `Buffer.from(s, "base64")` accepts and silently discards invalid characters. An
 *      investigator pasting a truncated token deserves an error, not a shorter answer.
 *   3. The same code has to run in the browser, where `Buffer` does not exist, because the
 *      whole point of this tool is that nothing is sent to a server.
 */

const HEX_DIGITS = "0123456789abcdef";
const BASE64_STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Lossy on purpose: shows U+FFFD where the bytes are not valid UTF-8, rather than failing. */
export function bytesToUtf8Lossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Strict: refuses rather than substituting replacement characters. */
export function bytesToUtf8(bytes: Uint8Array): ToolResult<string> {
  try {
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail("Those bytes are not valid UTF-8 text.");
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_DIGITS[byte >> 4];
    out += HEX_DIGITS[byte & 0x0f];
  }
  return out;
}

/**
 * Accepts the shapes people actually paste: `de ad be ef`, `de:ad:be:ef`, `0xdeadbeef`,
 * and mixed case. Rejects an odd digit count rather than guessing which nibble was meant.
 */
export function hexToBytes(input: string): ToolResult<Uint8Array> {
  const cleaned = input.replace(/^0x/i, "").replace(/[\s:_-]/g, "");
  if (cleaned.length === 0) return ok(new Uint8Array(0));
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    return fail("Hex may only contain 0-9 and a-f, optionally separated by spaces or colons.");
  }
  if (cleaned.length % 2 !== 0) {
    return fail(`Hex needs an even number of digits; this has ${cleaned.length}.`);
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return ok(bytes);
}

export interface Base64Options {
  /** RFC 4648 §5 alphabet: `-` and `_` instead of `+` and `/`. */
  readonly urlSafe?: boolean;
  /** Emit `=` padding. JWTs and many APIs omit it. */
  readonly pad?: boolean;
}

export function bytesToBase64(bytes: Uint8Array, options: Base64Options = {}): string {
  const alphabet = options.urlSafe ? BASE64_URL : BASE64_STANDARD;
  const pad = options.pad ?? !options.urlSafe;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const remaining = bytes.length - i;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += remaining > 1 ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : pad ? "=" : "";
    out += remaining > 2 ? alphabet[b2 & 0x3f] : pad ? "=" : "";
  }
  return out;
}

const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
  [...BASE64_STANDARD].flatMap((char, index) => {
    const urlChar = BASE64_URL[index];
    return urlChar !== undefined && urlChar !== char
      ? ([
          [char, index],
          [urlChar, index],
        ] as [string, number][])
      : ([[char, index]] as [string, number][]);
  }),
);

/**
 * Decodes either alphabet, with or without padding. Whitespace and newlines are stripped
 * because pasted tokens are usually wrapped; anything else is an error.
 */
export function base64ToBytes(input: string): ToolResult<Uint8Array> {
  const cleaned = input.replace(/\s+/g, "").replace(/=+$/, "");
  if (cleaned.length === 0) return ok(new Uint8Array(0));
  if (cleaned.length % 4 === 1) {
    return fail("That is not a whole number of base64 characters — one character is left over.");
  }
  const bytes = new Uint8Array(Math.floor((cleaned.length * 3) / 4));
  let bitBuffer = 0;
  let bitCount = 0;
  let written = 0;
  for (const char of cleaned) {
    const value = BASE64_VALUES.get(char);
    if (value === undefined) {
      return fail(`"${char}" is not a base64 character.`);
    }
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[written] = (bitBuffer >> bitCount) & 0xff;
      written += 1;
    }
  }
  return ok(bytes.subarray(0, written));
}

export function bytesToBase32(bytes: Uint8Array, options: { readonly pad?: boolean } = {}): string {
  const pad = options.pad ?? true;
  let out = "";
  let bitBuffer = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += BASE32_ALPHABET[(bitBuffer >> bitCount) & 0x1f];
    }
  }
  if (bitCount > 0) {
    out += BASE32_ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
  }
  if (pad) {
    while (out.length % 8 !== 0) out += "=";
  }
  return out;
}

export function base32ToBytes(input: string): ToolResult<Uint8Array> {
  const cleaned = input.replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) return ok(new Uint8Array(0));
  const bytes = new Uint8Array(Math.floor((cleaned.length * 5) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let written = 0;
  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      return fail(`"${char}" is not a base32 character. RFC 4648 base32 has no 0, 1 or 8.`);
    }
    bitBuffer = (bitBuffer << 5) | value;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[written] = (bitBuffer >> bitCount) & 0xff;
      written += 1;
    }
  }
  return ok(bytes.subarray(0, written));
}

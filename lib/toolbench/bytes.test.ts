import { describe, expect, it } from "vitest";

import {
  base32ToBytes,
  base64ToBytes,
  bytesToBase32,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  utf8ToBytes,
} from "./bytes";

/**
 * The expected values below are the test vectors published in RFC 4648 section 10. They are
 * not this implementation's own output: if a change here makes them fail, the change is
 * wrong, not the vector.
 */
const RFC4648 = [
  { input: "", base16: "", base32: "", base64: "" },
  { input: "f", base16: "66", base32: "MY======", base64: "Zg==" },
  { input: "fo", base16: "666f", base32: "MZXQ====", base64: "Zm8=" },
  { input: "foo", base16: "666f6f", base32: "MZXW6===", base64: "Zm9v" },
  { input: "foob", base16: "666f6f62", base32: "MZXW6YQ=", base64: "Zm9vYg==" },
  { input: "fooba", base16: "666f6f6261", base32: "MZXW6YTB", base64: "Zm9vYmE=" },
  { input: "foobar", base16: "666f6f626172", base32: "MZXW6YTBOI======", base64: "Zm9vYmFy" },
] as const;

describe("RFC 4648 test vectors", () => {
  for (const vector of RFC4648) {
    it(`encodes "${vector.input}"`, () => {
      const bytes = utf8ToBytes(vector.input);
      expect(bytesToHex(bytes)).toBe(vector.base16);
      expect(bytesToBase32(bytes)).toBe(vector.base32);
      expect(bytesToBase64(bytes)).toBe(vector.base64);
    });

    it(`decodes "${vector.input}"`, () => {
      const fromHex = hexToBytes(vector.base16);
      const fromBase32 = base32ToBytes(vector.base32);
      const fromBase64 = base64ToBytes(vector.base64);
      expect(fromHex.ok && bytesToUtf8(fromHex.value)).toEqual({ ok: true, value: vector.input });
      expect(fromBase32.ok && bytesToUtf8(fromBase32.value)).toEqual({
        ok: true,
        value: vector.input,
      });
      expect(fromBase64.ok && bytesToUtf8(fromBase64.value)).toEqual({
        ok: true,
        value: vector.input,
      });
    });
  }
});

describe("base64url", () => {
  // 0xfb 0xff encodes to "+/8=" in the standard alphabet and "-_8" url-safe: the two bytes
  // chosen because they exercise both characters that differ between the alphabets.
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);

  it("uses - and _ and drops padding by default", () => {
    expect(bytesToBase64(bytes)).toBe("+/+/");
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), { urlSafe: true })).toBe("-_8");
  });

  it("decodes either alphabet", () => {
    const standard = base64ToBytes("+/8=");
    const urlSafe = base64ToBytes("-_8");
    expect(standard.ok && Array.from(standard.value)).toEqual([0xfb, 0xff]);
    expect(urlSafe.ok && Array.from(urlSafe.value)).toEqual([0xfb, 0xff]);
  });

  it("tolerates wrapped whitespace, because pasted tokens are wrapped", () => {
    const decoded = base64ToBytes("Zm9v\n  YmFy");
    expect(decoded.ok && bytesToUtf8(decoded.value)).toEqual({ ok: true, value: "foobar" });
  });
});

describe("input a human typed", () => {
  it("accepts hex with separators and a 0x prefix", () => {
    for (const written of ["deadbeef", "DE AD BE EF", "de:ad:be:ef", "0xDEADBEEF"]) {
      const parsed = hexToBytes(written);
      expect(parsed.ok && bytesToHex(parsed.value)).toBe("deadbeef");
    }
  });

  it("refuses an odd number of hex digits rather than guessing the missing nibble", () => {
    expect(hexToBytes("abc")).toEqual({ ok: false, error: "Hex needs an even number of digits; this has 3." });
  });

  it("names the offending character in base32, including the digits it does not use", () => {
    const result = base32ToBytes("MZXW6YT1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("no 0, 1 or 8");
  });

  it("refuses a base64 string with a leftover character", () => {
    const result = base64ToBytes("Zm9vYmFyZ");
    expect(result.ok).toBe(false);
  });

  it("round-trips every byte value", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    const base64 = base64ToBytes(bytesToBase64(all));
    const base32 = base32ToBytes(bytesToBase32(all));
    const hex = hexToBytes(bytesToHex(all));
    expect(base64.ok && Array.from(base64.value)).toEqual(Array.from(all));
    expect(base32.ok && Array.from(base32.value)).toEqual(Array.from(all));
    expect(hex.ok && Array.from(hex.value)).toEqual(Array.from(all));
  });

  it("refuses to pretend invalid UTF-8 is text", () => {
    const result = bytesToUtf8(new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(result.ok).toBe(false);
  });
});

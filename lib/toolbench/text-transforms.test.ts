import { describe, expect, it } from "vitest";

import { utf8ToBytes, bytesToUtf8Lossy, bytesToHex } from "./bytes";
import {
  bruteForceSingleByteXor,
  rot47,
  rotN,
  urlDecode,
  urlEncode,
  xorBytes,
} from "./text-transforms";

describe("ROT-n", () => {
  it("is its own inverse at 13", () => {
    const text = "Attack at dawn, 07:30 UTC.";
    expect(rotN(rotN(text, 13), 13)).toBe(text);
  });

  it("matches the classic ROT13 example", () => {
    expect(rotN("Why did the chicken cross the road?", 13)).toBe(
      "Jul qvq gur puvpxra pebff gur ebnq?",
    );
  });

  it("leaves everything that is not an ASCII letter alone", () => {
    // The u-umlaut is untouched; m, l, a, u and t each move five places.
    expect(rotN("123 !@# ümlaut", 5)).toBe("123 !@# ürqfzy");
  });

  it("normalises a shift of any sign or size", () => {
    expect(rotN("abc", 26)).toBe("abc");
    expect(rotN("abc", -1)).toBe("zab");
    expect(rotN("abc", 27)).toBe("bcd");
  });

  it("rotates digits and punctuation under ROT47, and is its own inverse", () => {
    // The documented ROT47 example: "hello" becomes "96==@".
    expect(rot47("hello")).toBe("96==@");
    expect(rot47(rot47("Attack at 07:30!"))).toBe("Attack at 07:30!");
  });
});

describe("URL encoding", () => {
  it("distinguishes the three modes, which is what makes it useful", () => {
    const url = "https://example.com/a b?q=1&r=2";
    expect(urlEncode(url, "uri")).toBe("https://example.com/a%20b?q=1&r=2");
    expect(urlEncode(url, "component")).toBe(
      "https%3A%2F%2Fexample.com%2Fa%20b%3Fq%3D1%26r%3D2",
    );
    expect(urlEncode("a b", "form")).toBe("a+b");
  });

  it("round-trips each mode", () => {
    const text = "a b&c=d/e?f#g+h";
    for (const mode of ["component", "form"] as const) {
      const decoded = urlDecode(urlEncode(text, mode), mode);
      expect(decoded, mode).toEqual({ ok: true, value: text });
    }
  });

  it("refuses a truncated percent escape instead of returning something plausible", () => {
    const result = urlDecode("%E0%A4%A");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("two hex digits");
  });
});

describe("XOR", () => {
  it("is symmetric with a repeating key", () => {
    const data = utf8ToBytes("the quick brown fox");
    const key = utf8ToBytes("KEY");
    const encoded = xorBytes(data, key);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = xorBytes(encoded.value, key);
    expect(decoded.ok && bytesToUtf8Lossy(decoded.value)).toBe("the quick brown fox");
  });

  it("matches a hand-computed single-byte XOR", () => {
    // "A" is 0x41; 0x41 ^ 0xff = 0xbe.
    const result = xorBytes(utf8ToBytes("A"), new Uint8Array([0xff]));
    expect(result.ok && bytesToHex(result.value)).toBe("be");
  });

  it("refuses an empty key rather than returning the plaintext unchanged", () => {
    expect(xorBytes(utf8ToBytes("x"), new Uint8Array(0)).ok).toBe(false);
  });
});

describe("single-byte XOR brute force", () => {
  it("finds the key that turns a blob back into text", () => {
    const plaintext = "GET /admin/config.php HTTP/1.1\r\nHost: example.invalid\r\n";
    const encoded = xorBytes(utf8ToBytes(plaintext), new Uint8Array([0x5a]));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const candidates = bruteForceSingleByteXor(encoded.value, 5);
    expect(candidates[0]?.key).toBe(0x5a);
    expect(candidates[0]?.printableRatio).toBe(1);
    expect(candidates[0]?.preview.startsWith("GET /admin")).toBe(true);
  });

  it("ranks candidates without claiming to have decided", () => {
    const candidates = bruteForceSingleByteXor(new Uint8Array([1, 2, 3, 4]), 3);
    expect(candidates).toHaveLength(3);
    // Every candidate carries its own score, so the caller can see how weak the evidence is.
    for (const candidate of candidates) {
      expect(candidate.printableRatio).toBeGreaterThanOrEqual(0);
      expect(candidate.printableRatio).toBeLessThanOrEqual(1);
    }
  });
});

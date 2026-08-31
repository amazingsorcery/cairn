import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { utf8ToBytes } from "./bytes";
import { HASH_STANDING, hashAll, hashBytes } from "./hashing";

/**
 * MD5 vectors are the seven in RFC 1321 appendix A.5. SHA vectors are the published NIST
 * examples for the empty string and for "abc". None of them is this implementation's output.
 */
const MD5_VECTORS = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ],
  [
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    "57edf4a22be3c955ac49da2e2107b67a",
  ],
] as const;

describe("MD5 against the RFC 1321 vectors", () => {
  for (const [input, expected] of MD5_VECTORS) {
    it(`hashes "${input.slice(0, 24)}${input.length > 24 ? "..." : ""}"`, async () => {
      await expect(hashBytes("MD5", utf8ToBytes(input))).resolves.toBe(expected);
    });
  }

  /**
   * The RFC vectors are all short. Length padding is where an MD5 implementation actually
   * breaks — 55, 56 and 64 bytes straddle the boundary where the length field no longer fits
   * in the final block — and there are no published vectors at those lengths. So this checks
   * against Node's own MD5, which is an entirely independent implementation (OpenSSL), over
   * every length from 0 to 200 plus a block-boundary sweep.
   */
  it("agrees with OpenSSL at every length through the padding boundaries", async () => {
    for (let length = 0; length <= 200; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
      const expected = createHash("md5").update(bytes).digest("hex");
      await expect(hashBytes("MD5", bytes), `${length} bytes`).resolves.toBe(expected);
    }
  });

  it("agrees with OpenSSL on multi-block input", async () => {
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 131 + 7) & 0xff;
    const expected = createHash("md5").update(bytes).digest("hex");
    await expect(hashBytes("MD5", bytes)).resolves.toBe(expected);
  });
});

describe("WebCrypto hashes against the NIST examples", () => {
  it("hashes the empty string", async () => {
    const digests = await hashAll(new Uint8Array(0));
    expect(digests["SHA-1"]).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(digests["SHA-256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('hashes "abc"', async () => {
    const bytes = utf8ToBytes("abc");
    await expect(hashBytes("SHA-1", bytes)).resolves.toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
    await expect(hashBytes("SHA-256", bytes)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(hashBytes("SHA-384", bytes)).resolves.toBe(
      "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
    );
    await expect(hashBytes("SHA-512", bytes)).resolves.toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
  });

  it("hashes a Uint8Array that is a view into a larger buffer", async () => {
    // File slices arrive this way. Hashing the whole backing buffer would be a silent,
    // catastrophic wrong answer, so this is a regression guard, not a nicety.
    const backing = utf8ToBytes("xxxabcxxx");
    const view = backing.subarray(3, 6);
    await expect(hashBytes("SHA-256", view)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("standing", () => {
  it("marks MD5 and SHA-1 as broken so the UI cannot present them as evidence", () => {
    expect(HASH_STANDING["MD5"]).toBe("broken");
    expect(HASH_STANDING["SHA-1"]).toBe("broken");
    expect(HASH_STANDING["SHA-256"]).toBe("sound");
  });
});

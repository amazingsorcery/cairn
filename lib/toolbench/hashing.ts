import { bytesToHex } from "./bytes";
import { md5 } from "./md5";

/**
 * File and text hashing.
 *
 * SHA-1 and above come from WebCrypto, which is present in every browser this product
 * supports and is a native implementation rather than one we maintain. MD5 is ours
 * (`md5.ts`) because WebCrypto deliberately refuses to provide it.
 *
 * Everything here runs on bytes the caller already holds. Nothing is uploaded.
 */

export const HASH_ALGORITHMS = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"] as const;
export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

/**
 * Everything except MD5 comes from WebCrypto. Derived from `HashAlgorithm` by exclusion
 * rather than listed a second time, so adding an algorithm to the list above cannot leave
 * this one silently out of date.
 */
type WebCryptoAlgorithm = Exclude<HashAlgorithm, "MD5">;

function isWebCryptoAlgorithm(algorithm: HashAlgorithm): algorithm is WebCryptoAlgorithm {
  return algorithm !== "MD5";
}

/**
 * How much weight a match from this algorithm can carry.
 *
 * `broken` — a collision can be constructed on demand, so a match proves nothing about two
 * files being identical. `weakened` — no practical preimage attack, but collisions are
 * demonstrated and it should not be used for new integrity claims. `sound` — fit to record
 * in notes as the identity of a file.
 *
 * This is rendered next to every digest. An investigator writing a hash into a case file is
 * making a claim they may have to defend, and the tool has to say which claims survive.
 */
export type HashStanding = "broken" | "weakened" | "sound";

export const HASH_STANDING: Readonly<Record<HashAlgorithm, HashStanding>> = {
  MD5: "broken",
  "SHA-1": "broken",
  "SHA-256": "sound",
  "SHA-384": "sound",
  "SHA-512": "sound",
};

export const HASH_NOTE: Readonly<Record<HashAlgorithm, string>> = {
  MD5: "Broken for security. Chosen-prefix collisions are practical, so a match does not prove two files are identical. Use it only to reproduce a hash someone else published.",
  "SHA-1":
    "Broken for security. A chosen-prefix collision was demonstrated in 2020. Still the identifier Git and many older evidence logs use, so you will need to read it; do not create new integrity claims with it.",
  "SHA-256": "Sound. This is the digest to write into a case file.",
  "SHA-384": "Sound. A truncated SHA-512, useful where a counterpart specifies it.",
  "SHA-512": "Sound. Faster than SHA-256 on 64-bit hardware for large files.",
};

/** Hex digest of `bytes` under `algorithm`. */
export async function hashBytes(algorithm: HashAlgorithm, bytes: Uint8Array): Promise<string> {
  if (!isWebCryptoAlgorithm(algorithm)) return bytesToHex(md5(bytes));
  // A fresh copy rather than the caller's view. A Uint8Array can be a window onto a larger
  // buffer — which is exactly what a `File` slice produces — and handing WebCrypto the
  // underlying buffer would hash bytes outside the range the caller asked about. That is a
  // silent wrong answer, which for a hash is the worst kind. Copying is cheap next to the
  // digest itself.
  const digest = await crypto.subtle.digest(algorithm, bytes.slice());
  return bytesToHex(new Uint8Array(digest));
}

/** Every algorithm at once, which is what a file drop should show. */
export async function hashAll(bytes: Uint8Array): Promise<Readonly<Record<HashAlgorithm, string>>> {
  const entries = await Promise.all(
    HASH_ALGORITHMS.map(async (algorithm) => [algorithm, await hashBytes(algorithm, bytes)] as const),
  );
  return Object.fromEntries(entries) as Record<HashAlgorithm, string>;
}

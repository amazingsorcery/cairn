/**
 * MD5 (RFC 1321), implemented here because WebCrypto deliberately does not provide it.
 *
 * MD5 IS BROKEN FOR SECURITY. Chosen-prefix collisions are practical on ordinary hardware:
 * two different files can be constructed with the same MD5, so a matching MD5 is not proof
 * that two files are the same. Only the negative half of the answer is trustworthy — a
 * different MD5 does mean different bytes.
 *
 * It is here anyway because investigators meet it constantly in material they did not
 * choose: malware sample sets, VirusTotal and MISP records, old evidence logs, package and
 * torrent manifests. Being unable to reproduce a hash somebody else published is a real
 * obstacle. Use it to *match* an existing record. Never use it to establish the integrity of
 * something you are relying on; use SHA-256 for that.
 */

/** Per-round left-rotation amounts, RFC 1321 section 3.4. */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** K[i] = floor(2^32 * abs(sin(i + 1))), the constants defined in RFC 1321 section 3.4. */
const K: readonly number[] = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000),
);

function rotateLeft(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

/** Returns the 16-byte digest. */
export function md5(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  // Pad to 56 mod 64 bytes, then eight bytes of little-endian bit length.
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer);
  // A JavaScript number holds an integer exactly up to 2^53, far beyond any file a browser
  // can read into memory, so splitting the bit length into two 32-bit words this way is safe.
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Int32Array(16);

  for (let chunk = 0; chunk < paddedLength; chunk += 64) {
    for (let i = 0; i < 16; i += 1) M[i] = view.getInt32(chunk + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      // `| 0` keeps every intermediate inside int32. Without it the additions become
      // doubles and the low bits are silently lost once the sum passes 2^53.
      const sum = (a + f + (K[i] ?? 0) + (M[g] ?? 0)) | 0;
      b = (b + rotateLeft(sum, S[i] ?? 0)) | 0;
      a = temp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setInt32(0, a0, true);
  out.setInt32(4, b0, true);
  out.setInt32(8, c0, true);
  out.setInt32(12, d0, true);
  return digest;
}

/**
 * Comparing an embedded thumbnail against the picture it is supposed to be a thumbnail of.
 *
 * A camera writes a small JPEG preview into the EXIF block when it takes the photograph.
 * Most editors either update that preview or drop it; a few — and several careless
 * workflows — leave the original in place while the main image changes. When that happens
 * the thumbnail is a picture of what the file used to look like, and the difference between
 * them is the edit.
 *
 * WHAT A DIFFERENCE MEANS, and does not:
 *
 *   - A **large** difference is evidence that the visible image and the embedded preview
 *     disagree. It is not proof of a malicious edit: a crop, a rotation, an auto-enhance in
 *     the phone's gallery, or a legitimate correction produces one too. It tells you where
 *     to look, not what happened.
 *   - A **small** difference proves almost nothing. Any editor that regenerates the preview
 *     — which is most of them — leaves the two in agreement no matter what was done to the
 *     picture. **A clean comparison is not a clean file.**
 *   - **No thumbnail at all** is the commonest outcome and is not suspicious on its own.
 *     Every major social platform strips EXIF on upload, so a downloaded image usually has
 *     none. It does mean this check cannot be run, which is worth writing down.
 *
 * The two measures below are deliberately crude and are meant to be read together with the
 * two images side by side, which is why the tool renders both.
 */

/** Rec. 601 luma, the weighting used for perceptual greyscale. */
function luma(red: number, green: number, blue: number): number {
  return 0.299 * red + 0.587 * green + 0.114 * blue;
}

/**
 * Reduce an RGBA bitmap to a `size` x `size` grid of greyscale averages.
 *
 * Box-averaging rather than nearest-neighbour sampling, so that fine detail contributes to
 * the result instead of being aliased away — two images that differ only in a small region
 * should still register that difference.
 */
export function grayscaleSignature(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  size = 16,
): readonly number[] {
  const out = new Array<number>(size * size).fill(0);
  const counts = new Array<number>(size * size).fill(0);

  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(size - 1, Math.floor((y * size) / height));
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.min(size - 1, Math.floor((x * size) / width));
      const index = (y * width + x) * 4;
      const cell = cellY * size + cellX;
      out[cell] = (out[cell] ?? 0) + luma(pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }

  return out.map((total, index) => {
    const count = counts[index] ?? 0;
    return count === 0 ? 0 : total / count;
  });
}

/** Mean absolute difference of two signatures, on the 0-255 scale the samples use. */
export function meanAbsoluteDifference(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return total / a.length;
}

/**
 * Difference hash: 64 bits, each recording whether one cell is brighter than the cell to its
 * right. Built from a 9x8 greyscale grid.
 *
 * dHash is insensitive to brightness and to scale — which is exactly what is wanted when
 * comparing a 160-pixel thumbnail with a 4000-pixel photograph, because the two will never
 * agree on absolute pixel values however identical their content.
 */
export function differenceHash(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): readonly boolean[] {
  const grid = grayscaleSignatureRect(pixels, width, height, 9, 8);
  const bits: boolean[] = [];
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      bits.push((grid[row * 9 + column] ?? 0) > (grid[row * 9 + column + 1] ?? 0));
    }
  }
  return bits;
}

function grayscaleSignatureRect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  columns: number,
  rows: number,
): readonly number[] {
  const out = new Array<number>(columns * rows).fill(0);
  const counts = new Array<number>(columns * rows).fill(0);
  for (let y = 0; y < height; y += 1) {
    const cellY = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x += 1) {
      const cellX = Math.min(columns - 1, Math.floor((x * columns) / width));
      const index = (y * width + x) * 4;
      const cell = cellY * columns + cellX;
      out[cell] = (out[cell] ?? 0) + luma(pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  return out.map((total, index) => {
    const count = counts[index] ?? 0;
    return count === 0 ? 0 : total / count;
  });
}

/** Number of differing bits between two difference hashes, 0 to 64. */
export function hammingDistance(a: readonly boolean[], b: readonly boolean[]): number {
  if (a.length !== b.length) return Number.NaN;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) distance += 1;
  return distance;
}

export type ThumbnailVerdict = "consistent" | "differs" | "stronglyDiffers";

export interface ThumbnailComparison {
  /** 0 to 64. Under 10 is the conventional "probably the same picture" threshold. */
  readonly hammingDistance: number;
  /** 0 to 255. Sensitive to exposure and colour changes that dHash ignores by design. */
  readonly meanAbsoluteDifference: number;
  /** Difference in width divided by height. A crop or rotation shows up here first. */
  readonly aspectRatioDifference: number;
  readonly verdict: ThumbnailVerdict;
  /** One sentence saying what the verdict does and does not license the reader to conclude. */
  readonly reading: string;
}

export interface ImageSample {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Thresholds are the conventional dHash ones — under 10 bits of 64 is treated as the same
 * image, over 20 as a different one — with an explicit middle band rather than a forced
 * binary answer. They are heuristics, not measurements, and the returned `reading` says so.
 */
export function compareThumbnailToImage(
  thumbnail: ImageSample,
  full: ImageSample,
): ThumbnailComparison {
  const distance = hammingDistance(
    differenceHash(thumbnail.pixels, thumbnail.width, thumbnail.height),
    differenceHash(full.pixels, full.width, full.height),
  );
  const mad = meanAbsoluteDifference(
    grayscaleSignature(thumbnail.pixels, thumbnail.width, thumbnail.height),
    grayscaleSignature(full.pixels, full.width, full.height),
  );
  const aspectRatioDifference = Math.abs(
    thumbnail.width / thumbnail.height - full.width / full.height,
  );

  let verdict: ThumbnailVerdict = "consistent";
  if (distance > 20 || aspectRatioDifference > 0.1) verdict = "stronglyDiffers";
  else if (distance > 10 || mad > 24) verdict = "differs";

  const reading =
    verdict === "stronglyDiffers"
      ? "The embedded preview is not a picture of this image. Something changed the picture without regenerating the preview — a crop, a rotation, a replacement, or a composite. Compare the two views above before concluding which."
      : verdict === "differs"
        ? "The preview and the image agree on composition but not on tone. Exposure, colour or contrast adjustment produces this, and so does a light retouch. It is a lead, not a finding."
        : "The preview matches the image. This rules nothing out: most editors rewrite the preview, so a matching pair is equally consistent with no editing and with editing by any ordinary tool.";

  return { hammingDistance: distance, meanAbsoluteDifference: mad, aspectRatioDifference, verdict, reading };
}

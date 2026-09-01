import { fintrafficWeathercams } from "./fintraffic-weathercams";
import { tflJamCams } from "./tfl-jamcams";
import type { CameraProvider } from "./provider";

/**
 * THE CAMERA PROVIDER REGISTRY.
 *
 * Adding an operator is: write one file in this directory, record its terms in
 * `docs/sources/<slug>.md`, and add it to the array below. No map component changes, and the
 * cameras layer gains the whole of that operator's catalogue.
 *
 * **A provider ships only when its terms are confirmed** — the licence read, the attribution
 * string recorded verbatim, the rate limit found or measured, and the date written down.
 * Operators whose terms could not be confirmed, or whose embed permission could not be
 * established, stay in `content/cameras/link-only-providers.json` where the reader navigates
 * to the operator instead. A short registry we are certainly allowed to show beats a long one
 * we are not.
 *
 * Order is the order features are emitted, which is the table's natural order before sorting.
 */
export const CAMERA_PROVIDERS: readonly CameraProvider[] = [tflJamCams, fintrafficWeathercams];

/** One up by slug, or undefined. Undefined rather than throwing: an unknown slug is data. */
export function findCameraProvider(slug: string): CameraProvider | undefined {
  return CAMERA_PROVIDERS.find((provider) => provider.slug === slug);
}

/**
 * Re-exported for readers of this module. The list itself lives in `origins.ts`, which has no
 * imports, because `scripts/generate-csp.ts` must be able to read it without pulling in
 * `lib/env` — ADR 0018: the build must not require runtime secrets.
 */
export { CAMERA_STILL_IMAGE_ORIGINS } from "./origins";

export { CAMERA_MEDIA_FORMS, mediaFormsOf, toCameraFeature, isoDate } from "./provider";
export type {
  CameraFeature,
  CameraMediaForm,
  CameraMediaSet,
  CameraProvider,
  CameraProviderRead,
  CameraRecord,
  CameraStill,
  CameraStream,
  CameraVideo,
} from "./provider";

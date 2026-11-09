import { fintrafficWeathercams } from "./fintraffic-weathercams";
import { tflJamCams } from "./tfl-jamcams";
import type { CameraProvider } from "./provider";

/**
 * Camera provider registry. To add an operator: write one file here (with its terms in the
 * header comment) and add it below. No map component changes needed.
 *
 * Only add providers whose licence, attribution, rate limit and embed permission are
 * confirmed; others go in `content/cameras/link-only-providers.json`.
 *
 * Array order is feature emission order.
 */
export const CAMERA_PROVIDERS: readonly CameraProvider[] = [tflJamCams, fintrafficWeathercams];

/** One up by slug, or undefined. Undefined rather than throwing: an unknown slug is data. */
export function findCameraProvider(slug: string): CameraProvider | undefined {
  return CAMERA_PROVIDERS.find((provider) => provider.slug === slug);
}

/**
 * Lives in import-free `origins.ts` so `scripts/generate-csp.ts` can read it without
 * `lib/env` (the build must not need runtime secrets).
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

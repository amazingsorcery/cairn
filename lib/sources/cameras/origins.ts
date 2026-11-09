/**
 * Every origin a camera **still image** may be loaded from.
 *
 * No imports: `scripts/generate-csp.ts` reads this at build time to produce
 * `infra/csp.caddy`, and importing the providers would pull in `lib/env` and require runtime
 * secrets. Providers import their origin from here; `cameras/registry.test.ts` checks every
 * emitted still URL is covered.
 *
 * Only stills: `img-src` is an allowlist, while `media-src` is `'self' https:` because
 * video/stream hosts change too often to allowlist.
 */

/**
 * TfL serves JamCam stills and MP4s from a shared public S3 endpoint, so this admits every
 * public bucket in eu-west-1 (flagged in the generated CSP). Still tighter than `https:`, and
 * we don't proxy frames.
 */
export const TFL_JAMCAMS_IMAGE_ORIGIN = "https://s3-eu-west-1.amazonaws.com";

/** Fintraffic's own weathercam host, documented at digitraffic.fi/en/road-traffic/. */
export const FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN = "https://weathercam.digitraffic.fi";

/**
 * Read by the CSP generator; sorted and de-duplicated for stable output. Adding a host
 * changes `infra/csp.caddy`, and CI fails until the regenerated file is committed.
 */
export const CAMERA_STILL_IMAGE_ORIGINS: readonly string[] = [
  ...new Set([TFL_JAMCAMS_IMAGE_ORIGIN, FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN]),
].sort();

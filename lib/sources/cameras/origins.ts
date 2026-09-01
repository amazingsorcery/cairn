/**
 * Every origin a camera **still image** may be loaded from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ITS OWN FILE, WITH NO IMPORTS
 * ─────────────────────────────────────────────────────────────────────────────
 * `scripts/generate-csp.ts` reads it at build time to produce `infra/csp.caddy`. Importing
 * the provider modules instead would drag in `lib/sources/adapter` -> `lib/sources/http` ->
 * `lib/logger` -> `lib/env`, and the generator would then require `DATABASE_URL` and
 * `AUTH_SECRET` to emit a Caddy snippet. ADR 0018 is explicit that the build must not require
 * runtime secrets, and a CSP generator that cannot run in CI is a CSP that drifts.
 *
 * So this is a leaf: string literals, no imports, nothing to evaluate. The providers import
 * their own origin FROM here rather than declaring it themselves, so there is one spelling
 * per host, and `cameras/registry.test.ts` asserts that every still URL each provider emits
 * from its captured fixture has an origin in this list. A provider that quietly starts
 * serving from a new host fails that test rather than failing silently in production.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ONLY STILLS
 * ─────────────────────────────────────────────────────────────────────────────
 * `img-src` is an allowlist and `media-src` is `'self' https:`. So a new still-image host
 * needs an entry here and a regenerated `infra/csp.caddy`; a new video or stream host does
 * not. That asymmetry is deliberate — the still hosts are a short, stable list of national
 * road authorities, while video and audio endpoints move around and an allowlist for them
 * would be stale within a week (the same argument `media-src` already carries for radio).
 */

/**
 * TfL serves JamCam stills and MP4s from a public S3 bucket.
 *
 * **This is shared infrastructure, not TfL's own host.** Allowlisting it admits every public
 * bucket in eu-west-1, not just `jamcams.tfl.gov.uk`. `generate-csp.ts` flags it in the
 * generated file so the widening is visible to a reader rather than looking specific because
 * it contains a hostname. It is still far tighter than `img-src https:`, and the alternative
 * — proxying the frames — is the one thing product-brief §2b forbids outright.
 */
export const TFL_JAMCAMS_IMAGE_ORIGIN = "https://s3-eu-west-1.amazonaws.com";

/** Fintraffic's own weathercam host, documented at digitraffic.fi/en/road-traffic/. */
export const FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN = "https://weathercam.digitraffic.fi";

/**
 * The list the CSP generator reads. Sorted and de-duplicated so the generated file is stable.
 *
 * **Adding a host here changes `infra/csp.caddy`, and CI fails until the regenerated file is
 * committed.** That is the intended behaviour: widening a security policy should appear in a
 * diff a human reads (ADR 0017).
 */
export const CAMERA_STILL_IMAGE_ORIGINS: readonly string[] = [
  ...new Set([TFL_JAMCAMS_IMAGE_ORIGIN, FINTRAFFIC_WEATHERCAMS_IMAGE_ORIGIN]),
].sort();

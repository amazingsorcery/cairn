import { authConfig } from "@/lib/auth";

import {
  formatLinkLifetime as format,
  resolveMaxAgeSeconds,
} from "./magic-link-max-age";

/**
 * Magic-link lifetime read from the real Auth.js config, so the copy never drifts from it.
 * The logic lives in `./magic-link-max-age.ts`, which has no imports so it's testable.
 */
/**
 * The configured lifetime, or `null` when it can't be read (no email provider, or a
 * provider shape change in `@auth/core`). No fallback to the 24-hour default, since that
 * would look like a correct read.
 */
export const MAGIC_LINK_MAX_AGE_SECONDS: number | null = resolveMaxAgeSeconds(
  authConfig.providers,
);

/**
 * The lifetime as a phrase, or `null` when unknown; callers then omit the number.
 */
export function formatLinkLifetime(
  seconds: number | null = MAGIC_LINK_MAX_AGE_SECONDS,
): string | null {
  return seconds === null ? null : format(seconds);
}

import { authConfig } from "@/lib/auth";

import {
  formatLinkLifetime as format,
  resolveMaxAgeSeconds,
} from "./magic-link-max-age";

/**
 * The magic-link lifetime, bound to the shipped Auth.js configuration.
 *
 * `docs/design/states.md` §6.4 and §6.5 both interpolate this value ("expires in <n>
 * minutes", "links last <n> minutes"). Reading it from the real config rather than retyping
 * it is what made shortening the link to 15 minutes a one-line change in `lib/auth.ts` with
 * no copy edit anywhere.
 *
 * All of the logic — and the reason the obvious read of `maxAge` is wrong — lives in
 * `./magic-link-max-age.ts`, which imports nothing so it can be tested directly.
 */
/**
 * The configured lifetime, or `null` when it cannot be read.
 *
 * `null` is a real outcome, not an error: no email provider configured, or `@auth/core`
 * changing its provider shape on an upgrade. It deliberately does NOT fall back to the
 * 24-hour default, because that value would be indistinguishable from a correct read — the
 * exact failure this module was written to fix.
 */
export const MAGIC_LINK_MAX_AGE_SECONDS: number | null = resolveMaxAgeSeconds(
  authConfig.providers,
);

/**
 * The lifetime as a phrase, or `null` when we do not know it.
 *
 * Callers render the duration only when this returns a string. When it returns `null` they
 * say the link is single-use and short-lived, without claiming to know how short. A page
 * that omits the number is honest; a page that invents a specific, wrong,
 * security-relevant number is not.
 */
export function formatLinkLifetime(
  seconds: number | null = MAGIC_LINK_MAX_AGE_SECONDS,
): string | null {
  return seconds === null ? null : format(seconds);
}

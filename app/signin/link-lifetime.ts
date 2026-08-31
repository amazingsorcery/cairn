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
export const MAGIC_LINK_MAX_AGE_SECONDS = resolveMaxAgeSeconds(authConfig.providers);

export function formatLinkLifetime(seconds: number = MAGIC_LINK_MAX_AGE_SECONDS): string {
  return format(seconds);
}

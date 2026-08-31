import { authConfig } from "@/lib/auth";

/**
 * How long a magic link is valid for, read from the shipped Auth.js configuration rather
 * than retyped.
 *
 * `docs/design/states.md` §6.4 and §6.5 both interpolate this value ("expires in <n>
 * minutes", "links last <n> minutes"). A hardcoded number here would become a factual
 * error the first time `maxAge` in `lib/auth.ts` changed, and this product may not make
 * factual errors about its own behaviour (`docs/product-brief.md` §6).
 *
 * RESOLVED: `maxAge` is now 15 minutes, matching what `states.md` was drafted against.
 * Auth.js defaults to 24 hours, which is a long time for a bearer credential sitting in an
 * inbox belonging to someone whose email is worth compromising. The note below is kept
 * because the mechanism still matters: the shipped `maxAge` used to be 24 hours, not the
 * the design copy was drafted against, so the rendered sentence reads "expires in 24 hours".
 * That is the honest rendering of what actually ships. If 15 minutes was the intent, change
 * `maxAge` and this text follows automatically. See `docs/frontend/HANDOFF-workspaces.md` §7.
 */

const FALLBACK_SECONDS = 24 * 60 * 60;

function readMaxAgeSeconds(): number {
  for (const provider of authConfig.providers) {
    // A provider may be supplied as a factory; only the resolved object carries `maxAge`.
    if (typeof provider === "function") continue;
    if (!("type" in provider) || provider.type !== "email") continue;
    const { maxAge } = provider;
    if (typeof maxAge === "number" && Number.isFinite(maxAge) && maxAge > 0) return maxAge;
  }
  return FALLBACK_SECONDS;
}

export const MAGIC_LINK_MAX_AGE_SECONDS = readMaxAgeSeconds();

/**
 * "24 hours", "15 minutes", "90 minutes". Whole units only: a link lifetime expressed to
 * the second invites a reader to believe we are counting, and we are not.
 */
export function formatLinkLifetime(seconds: number = MAGIC_LINK_MAX_AGE_SECONDS): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

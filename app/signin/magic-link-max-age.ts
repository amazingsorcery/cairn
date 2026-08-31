/**
 * How long a magic link lasts, resolved from an Auth.js provider list.
 *
 * NO IMPORTS, BY DESIGN. `link-lifetime.ts` binds this to the real `authConfig`; keeping the
 * logic here means the tests can exercise it without dragging next-auth's server runtime
 * into jsdom, and — more importantly — against a FIXTURE of the shape that actually broke,
 * rather than against whatever this deployment happens to be configured with.
 *
 * WHERE `maxAge` ACTUALLY LIVES, AND WHY THE OBVIOUS READ IS WRONG.
 * `Nodemailer()` from `@auth/core` does NOT merge the caller's config into the object it
 * returns. It returns its own defaults — including a hardcoded `maxAge: 24 * 60 * 60` — and
 * stashes what the caller passed under a separate `options` key. The merge happens later, at
 * request time, in `@auth/core/lib/utils/providers.js`:
 *
 *     const { options: userOptions, ...defaults } = provider;
 *     const merged = merge(defaults, userOptions, { ... });   // userOptions WIN
 *
 * So the effective lifetime is `options.maxAge` when the caller set one, and only otherwise
 * the factory's 24-hour default. Reading `provider.maxAge` alone gets the default every time
 * and silently ignores what `lib/auth.ts` asked for.
 *
 * That is not hypothetical: it shipped. While `lib/auth.ts` also said 24 hours the wrong read
 * happened to agree, so nothing looked broken. The moment the link was shortened to 15
 * minutes, `/signin/check-email` began telling people their link lasts a day when it dies in
 * a quarter of an hour — an overstatement about the lifetime of a bearer credential, on a
 * security page, for an audience whose mailbox is worth compromising.
 */

/** `@auth/core`'s own default, which applies only when nothing overrides it. */
export const AUTHJS_DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

/** A positive finite number at `path` inside an unknown value, or null. No casts, no `any`. */
function numericAt(source: unknown, ...path: readonly string[]): number | null {
  let current: unknown = source;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) && current > 0 ? current : null;
}

/**
 * Returns `null` when the lifetime cannot be read, and DOES NOT fall back to the 24-hour
 * default.
 *
 * That fallback was here, and it is the same shape as the bug this module exists to fix: a
 * value that is indistinguishable from a correct read. If no email provider is configured —
 * or its shape changes again on an upgrade — a silent 24 would put a specific, wrong,
 * security-relevant number in front of a reader with nothing to signal it was a guess.
 *
 * A page that omits the number is honest. A page that invents it is not. Callers render the
 * duration only when this returns a value, and otherwise say the link is single-use and
 * short-lived without claiming to know how short.
 */
export function resolveMaxAgeSeconds(providers: readonly unknown[]): number | null {
  for (const provider of providers) {
    // A provider may be supplied as a factory; only the resolved object carries config.
    if (typeof provider !== "object" || provider === null) continue;
    if ((provider as Record<string, unknown>).type !== "email") continue;

    // `options` first: it is what the caller asked for, and it wins at request time.
    const configured = numericAt(provider, "options", "maxAge");
    if (configured !== null) return configured;
    const factoryDefault = numericAt(provider, "maxAge");
    if (factoryDefault !== null) return factoryDefault;
  }
  return null;
}

/**
 * "24 hours", "15 minutes", "90 minutes". Whole units only: a link lifetime expressed to
 * the second invites a reader to believe we are counting, and we are not.
 *
 * `null` in, `null` out — an unknown lifetime must stay unknown all the way to the page, so
 * a caller cannot accidentally render "0 minutes" for "we could not read it".
 */
export function formatLinkLifetime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

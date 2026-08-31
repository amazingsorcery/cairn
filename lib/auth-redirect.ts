/* ------------------------------------------------------------------ *
 * Redirect safety
 * ------------------------------------------------------------------ */

/**
 * Decide where a sign-in may land. This is the open-redirect surface and it is attacked
 * with URLs that look same-origin to a careless check:
 *
 *   //evil.test/x          protocol-relative — a browser reads this as another origin
 *   /\evil.test/x          backslash; some parsers normalise it to `//`
 *   https://app.test.evil  prefix match on the origin string succeeds, host differs
 *   https://evil.test?u=https://app.test   the real host is evil.test
 *
 * So: parse with the URL API against our own base and compare `origin` exactly. Anything
 * that fails to parse, or parses to a different origin, becomes the base URL. Never
 * reflect an attacker-supplied absolute URL back into a redirect.
 *
 * Exported for unit tests — this function is where an open redirect would live and QA is
 * going to attack it.
 */
export function safeRedirect(url: string, baseUrl: string): string {
  // Reject before parsing: a bare `//host` or `/\host` is relative-looking but resolves to
  // a foreign origin, and no legitimate callback in this app begins that way.
  if (/^\s*[/\\]{2}/.test(url)) return baseUrl;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return baseUrl;
  }

  let target: URL;
  try {
    // A relative path resolves against `base`; an absolute URL ignores it. Either way the
    // origin comparison below is what decides.
    target = new URL(url, base);
  } catch {
    return baseUrl;
  }

  if (target.origin !== base.origin) return baseUrl;

  // Return path + query + fragment only. Returning `target.href` would be equivalent here,
  // but a relative result cannot become an absolute redirect if this is ever refactored.
  return `${target.pathname}${target.search}${target.hash}`;
}

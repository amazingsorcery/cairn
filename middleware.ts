import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware. Deliberately tiny, because it runs on every matched request.
 *
 * IT DOES TWO THINGS, AND NEITHER OF THEM IS AUTHORISATION.
 *
 * 1. **A redirect convenience.** A signed-out visitor to `/workspaces/**` or `/admin/**` is
 *    sent to `/signin` rather than being shown a broken page (sitemap.md §7 and §8,
 *    HANDOFF §11.1). `sitemap.md` §8 states the rule plainly: "Middleware alone is not
 *    authorisation; it is a redirect convenience." Every page and every Server Action
 *    re-checks the session and the role against the database, and every workspace query
 *    carries `user_id = $session` in SQL.
 *
 * 2. **`Cache-Control: private, no-store`** on the signed-in prefixes (`caching.md` §7,
 *    which permits either the route handler or middleware to set it). Setting it in one
 *    place means a new route under `/workspaces` cannot forget.
 *
 * WHY IT ONLY LOOKS FOR A COOKIE, and does not validate it: sessions are rows in Postgres
 * (product-brief §5), and Next.js middleware runs on the Edge runtime where the `pg` driver
 * does not exist. Calling `auth()` here would either fail to build or force the whole
 * middleware into the Node runtime for a check that is then repeated properly a moment
 * later. A forged cookie gets past this and straight into a real session lookup that
 * rejects it; the only thing lost is one redirect.
 *
 * `/api/health` is NOT matched. docs/deploy/HANDOFF.md A#2: it "must not be behind
 * middleware that redirects", because the Docker HEALTHCHECK, the Compose `depends_on` gate,
 * `deploy.sh`'s rollback decision and Playwright's readiness probe all follow it.
 */

/**
 * Auth.js v5 cookie names. The `__Secure-` prefix is used when the derived protocol is
 * https, which behind Caddy it is (`X-Forwarded-Proto: https` plus `AUTH_TRUST_HOST=true`),
 * so both are checked rather than guessing which environment this is.
 */
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"] as const;

const PROTECTED_PREFIXES = ["/workspaces", "/admin"] as const;

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) return NextResponse.next();

  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  if (!hasSessionCookie) {
    const signIn = new URL("/signin", request.nextUrl.origin);
    // Only the path and query from THIS request — never a value read from a query string,
    // which is how a sign-in redirect becomes an open redirect. `lib/auth-redirect.ts`
    // re-checks the origin on the way back out regardless.
    signIn.searchParams.set("callbackUrl", `${pathname}${search}`);
    const redirect = NextResponse.redirect(signIn);
    redirect.headers.set("Cache-Control", "private, no-store");
    return redirect;
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

/**
 * Matched paths only. Everything else — the whole public catalogue, every static asset, and
 * `/api/health` — skips this file entirely, which is the difference between middleware that
 * costs nothing and middleware that taxes every request on a 2 GB VPS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `/toolbench/*` AND `/api/*` ARE DELIBERATELY OUTSIDE THIS MATCHER
 * ─────────────────────────────────────────────────────────────────────────────
 * QA finding QV-25 noted, correctly, that this matcher is the reason nothing above the
 * Toolbench routes or `/api/live/flights` counted anything, and that nothing said so. It
 * says so now, and the answer is not to widen the matcher.
 *
 * Those surfaces are anonymous by design and have no session to check, so middleware could
 * only rate-limit them — and middleware runs on the Edge runtime, where `lib/rate-limit.ts`
 * cannot: the counter is a Postgres upsert through the Node `pg` driver. A limiter here
 * would have to be a second implementation with a second store, which is the "three
 * containers and stays that way" line in the conventions §3 and the drift QV-18 records the cost
 * of.
 *
 * So the limiter is `connector-entry`, consumed inside `runConnector` — the chokepoint every
 * one of those surfaces must cross to reach an upstream at all. See
 * `lib/connectors/runtime.ts` step 0 and `tests/security/connector-entry-points.test.ts`,
 * which asserts the inventory of those surfaces and that each reaches the connector seam
 * only through that function.
 */
export const config = {
  matcher: ["/workspaces/:path*", "/admin/:path*"],
};

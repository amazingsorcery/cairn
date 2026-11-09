import { NextResponse, type NextRequest } from "next/server";

import { deriveSignInMode } from "@/lib/auth-mode";

/**
 * Middleware. Not authorisation: pages, Server Actions and queries all re-check the session.
 *
 * 1. Redirects signed-out visitors on `/workspaces/**` and `/admin/**` to `/signin`
 *    (except in public-only mode, where `/signin` doesn't exist either).
 * 2. Sets `Cache-Control: private, no-store` on those prefixes in one place.
 *
 * Only checks that a session cookie exists: sessions live in Postgres and `pg` isn't
 * available on Edge. A forged cookie just fails the real lookup later.
 *
 * `/api/health` is not matched; health checks and deploy gating must never be redirected.
 */

/** Auth.js cookie names; `__Secure-` is used over https (behind Caddy). */
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"] as const;

const PROTECTED_PREFIXES = ["/workspaces", "/admin"] as const;

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) return NextResponse.next();

  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));

  /*
   * Public-only mode: no redirect (`/signin` isn't served), but still set the headers.
   *
   * Reads `process.env` directly (lib/env needs Node). On Edge this is a runtime read, since
   * only NEXT_PUBLIC_* is inlined at build. Same `deriveSignInMode` as `lib/env.ts`.
   */
  const signInEnabled = deriveSignInMode(process.env).enabled;

  if (!hasSessionCookie && signInEnabled) {
    const signIn = new URL("/signin", request.nextUrl.origin);
    // This request's own path, never a query value (open redirect). lib/auth-redirect.ts
    // re-checks the origin too.
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
 * Only the signed-in prefixes; everything else skips middleware.
 *
 * `/toolbench/*` and `/api/*` are anonymous, so middleware could only rate-limit them, and
 * the Postgres-backed limiter can't run on Edge. They're limited by `connector-entry`
 * inside `runConnector` instead (see `lib/connectors/runtime.ts` and
 * `tests/security/connector-entry-points.test.ts`).
 */
export const config = {
  matcher: ["/workspaces/:path*", "/admin/:path*"],
};

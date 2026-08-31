import { handlers } from "@/lib/auth";

/**
 * The Auth.js route handler. Everything under `/api/auth/*` — sign-in, callback, session,
 * CSRF, sign-out — is served from here.
 *
 * Never cached: docs/architecture/caching.md §7. Caddy additionally sets
 * `X-Robots-Tag: noindex` on `/api/*`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = handlers;

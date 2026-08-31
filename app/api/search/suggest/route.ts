import { NextResponse } from "next/server";

import { suggest } from "@/lib/queries/search";
import { clientSubject, consumeSafely } from "@/lib/rate-limit";
import { suggestQuerySchema } from "@/lib/validation/filters";

/**
 * Type-ahead for the search field. `search.md` §6.5, `sitemap.md` §4.
 *
 * NEVER CACHED, at any layer — and the reason is not performance. `caching.md` §7: "A shared
 * cache of partial search queries, keyed by prefix and warmed by whoever typed first, is a
 * readable log of what this audience is looking into." Product-brief §3.2 constraint 4
 * covers our own infrastructure, not only third-party trackers.
 *
 * Rate limited per HASHED client identifier (ADR 0009): one indexed query per debounced
 * keystroke, unauthenticated, is the cheapest way to make a small VPS work hard.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  // Belt and braces with the Caddyfile, which sets this on /api/* as well.
  "X-Robots-Tag": "noindex",
} as const;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = suggestQuerySchema.safeParse({ q: url.searchParams.get("q") ?? "" });

  // A short or missing query is an empty list, not an error: the field calls this on every
  // debounce and a 400 in the console on every first keystroke is noise, not information.
  if (!parsed.success) {
    return NextResponse.json({ results: [] }, { headers: NO_STORE });
  }

  const decision = await consumeSafely("search-suggest", clientSubject(request));
  if (!decision.ok) {
    return NextResponse.json(
      { results: [], limited: true },
      {
        status: 429,
        headers: {
          ...NO_STORE,
          "Retry-After": String(Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000))),
        },
      },
    );
  }

  const results = await suggest(parsed.data.q);
  return NextResponse.json({ results }, { headers: NO_STORE });
}

import { NextResponse } from "next/server";

import { suggest } from "@/lib/queries/search";
import { clientSubject, consumeSafely } from "@/lib/rate-limit";
import { suggestQuerySchema } from "@/lib/validation/filters";

/**
 * Type-ahead for the search field. Never cached at any layer: a shared cache of partial
 * queries would be a readable log of what users are searching for.
 *
 * Rate limited per hashed client identifier, since it's an unauthenticated query per keystroke.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  // Caddy sets this on /api/* too.
  "X-Robots-Tag": "noindex",
} as const;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = suggestQuerySchema.safeParse({ q: url.searchParams.get("q") ?? "" });

  // Short or missing query: empty list rather than a 400 on every first keystroke.
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

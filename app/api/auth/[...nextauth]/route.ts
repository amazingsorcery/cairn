import { handlers } from "@/lib/auth";

/**
 * Auth.js route handler for everything under `/api/auth/*`. Never cached; Caddy also sets
 * `X-Robots-Tag: noindex` on `/api/*`.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, POST } = handlers;

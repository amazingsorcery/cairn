import { addWorkspaceItem } from "@/lib/actions/workspaces";
import { logger } from "@/lib/logger";
import { requireSignInEnabled } from "@/lib/session-surface";

/**
 * `POST /map/save/submit`: form target for the map save picker.
 *
 * A route handler rather than a Server Action: Server Actions can drop a click before
 * hydration or a save on navigation; a native form POST can't. See the tool-save handler.
 *
 * `addWorkspaceItem` handles session, rate limit, validation and ownership, and builds the
 * snapshot from `lib/live/feature-cache.ts`. The form fields are only a cache lookup key.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Outcome code; the page owns the copy so a crafted link can't inject text. */
type Outcome = "saved" | "already" | "busy" | "gone" | "failed" | "invalid" | "signedout";

/**
 * CSRF check (route handlers don't get Server Actions' built-in one). Compares `Origin` to
 * the Host header, not `request.url`, whose host is the server's binding behind a proxy.
 * No `Origin` plus a same-origin `Sec-Fetch-Site` is a normal same-origin form post.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (!host) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

export async function POST(request: Request): Promise<Response> {
  // Public-only mode: 404 before reading the body.
  requireSignInEnabled();

  const form = await request.formData().catch(() => null);
  const workspaceId = form ? String(form.get("workspaceId") ?? "") : "";
  const sourceSlug = form ? String(form.get("source") ?? "") : "";
  const featureRef = form ? String(form.get("feature") ?? "") : "";

  /**
   * Relative `Location` so the browser keeps the host it used (an absolute URL from
   * `request.url` can switch hosts and lose the session cookie). 303 so reload doesn't resubmit.
   */
  const back = (outcome: Outcome): Response => {
    const query = new URLSearchParams({ source: sourceSlug, feature: featureRef, outcome });
    if (workspaceId) query.set("case", workspaceId);
    return new Response(null, {
      status: 303,
      headers: { Location: `/map/save?${query.toString()}` },
    });
  };

  if (!sameOrigin(request)) {
    logger.warn({ scope: "map-feature-save" }, "Rejected a cross-origin save");
    return back("invalid");
  }

  if (!workspaceId || !sourceSlug || !featureRef) return back("invalid");

  const result = await addWorkspaceItem({
    workspaceId,
    kind: "mapFeature",
    toolId: null,
    stepId: null,
    feature: { sourceSlug, featureRef },
  });

  if (result.ok) return back("saved");
  // Session lapsed while the page was open.
  if (result.code === "unauthenticated") return back("signedout");
  if (result.code === "notFound") return back("gone");
  if (result.code === "conflict") {
    // Duplicate and rate limit both come back as `conflict`; only the message tells them
    // apart. Falls back to `busy` if the wording changes.
    const already = result.message.toLowerCase().includes("already saved");
    return back(already ? "already" : "busy");
  }
  return back("failed");
}

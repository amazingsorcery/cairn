import { addWorkspaceItem } from "@/lib/actions/workspaces";
import { logger } from "@/lib/logger";
import { getToolBySlug } from "@/lib/queries/tools";
import { requireSignInEnabled } from "@/lib/session-surface";

/**
 * `POST /tools/[slug]/save/submit`: form target for the save picker.
 *
 * A route handler, not a Server Action. With a Server Action, a click before hydration does
 * nothing, and after hydration the submit is a background `fetch` that's aborted if the user
 * navigates away. A native form POST has neither problem (covered by
 * `tests/e2e/vertical-slice.spec.ts`).
 *
 * `addWorkspaceItem` handles session, validation and ownership, and reads the snapshot title
 * from the database. The tool id comes from the route slug, never the form body.
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  // Public-only mode: 404 before reading the body.
  requireSignInEnabled();

  const { slug } = await params;
  /**
   * Relative `Location` so the browser keeps the host it used (an absolute URL from
   * `request.url` can switch hosts and lose the session cookie). 303 so reload doesn't resubmit.
   */
  const back = (outcome: Outcome, workspaceId?: string) => {
    const query = new URLSearchParams({ outcome });
    if (workspaceId) query.set("case", workspaceId);
    const location = `/tools/${encodeURIComponent(slug)}/save?${query.toString()}`;
    return new Response(null, { status: 303, headers: { Location: location } });
  };

  if (!sameOrigin(request)) {
    logger.warn({ scope: "tool-save" }, "Rejected a cross-origin save");
    return back("invalid");
  }

  const form = await request.formData().catch(() => null);
  const workspaceId = form ? String(form.get("workspaceId") ?? "") : "";
  if (!workspaceId) return back("invalid");

  const tool = await getToolBySlug(slug);
  if (!tool) return back("gone", workspaceId);

  const result = await addWorkspaceItem({
    workspaceId,
    kind: "tool",
    toolId: tool.id,
    stepId: null,
  });

  if (result.ok) return back("saved", workspaceId);
  // Session lapsed while the page was open.
  if (result.code === "unauthenticated") return back("signedout", workspaceId);
  if (result.code === "notFound") return back("gone", workspaceId);
  if (result.code === "conflict") {
    // Duplicate and rate limit both come back as `conflict`; only the message tells them
    // apart. Falls back to `busy` if the wording changes.
    const already = result.message.toLowerCase().includes("already saved");
    return back(already ? "already" : "busy", workspaceId);
  }
  return back("failed", workspaceId);
}

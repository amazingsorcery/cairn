import { addWorkspaceItem } from "@/lib/actions/workspaces";
import { logger } from "@/lib/logger";
import { getToolBySlug } from "@/lib/queries/tools";

/**
 * `POST /tools/[slug]/save/submit` — the save picker's form target.
 *
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION. Two earlier versions of this used a Server
 * Action and both lost a race, in opposite directions, and `tests/e2e/vertical-slice.spec.ts`
 * caught each one:
 *
 *   1. Called from `onClick`, a tap that lands between the server HTML arriving and React
 *      attaching does nothing at all — silently. A real reader on a slow connection sees a
 *      button that looks ready and is not.
 *   2. As `<form action={serverAction}>`, React intercepts the submit after hydration and
 *      sends it as a background `fetch`. If the reader navigates away in the moment after
 *      clicking, the connection drops, Next aborts the action, and the save is lost — with the
 *      button having already shown that it was pressed.
 *
 * A native `<form method="post">` to a Route Handler has neither window. The browser commits
 * to the request before it leaves the page, React never intercepts it, and it works with the
 * bundle removed. The cost is a full page load per save, which for a control used once per
 * entry is the right trade for never silently dropping one.
 *
 * IT WRITES NO SQL AND INVENTS NO ACTION. `addWorkspaceItem` re-checks the session,
 * Zod-validates, re-checks ownership inside its transaction, and reads the snapshot title FROM
 * THE DATABASE rather than from the form (ADR 0008). The tool id is resolved HERE from the
 * route's own slug, never from the posted body, so the one value the reader has no business
 * choosing never round-trips through the client.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What the attempt did. A short code, so the page owns the copy and a crafted link cannot. */
type Outcome = "saved" | "already" | "busy" | "gone" | "failed" | "invalid" | "signedout";

/**
 * Same-origin check.
 *
 * A Server Action gets this from the framework; a Route Handler does not, and this one writes
 * to the signed-in user's own data, so a cross-site form post must not reach it. `Origin` is
 * set by every browser on a cross-origin form POST and cannot be forged by page script.
 *
 * It is compared against the **Host header** — the authority the browser actually addressed —
 * and not against `request.url`, whose host is the server's own binding and differs from the
 * one the reader used the moment anything sits in front of it. Getting that wrong rejects
 * every genuine save, which is exactly what happened the first time.
 *
 * A missing `Origin` with a same-site `Sec-Fetch-Site` is the ordinary same-origin form case.
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
  const { slug } = await params;
  /**
   * A RELATIVE `Location`, which browsers resolve against the address they used. An absolute
   * URL built from `request.url` would send the reader to the server's own binding — which is
   * how the first version bounced `127.0.0.1` visitors to `localhost` and lost their session
   * cookie on the way.
   *
   * 303: the result of a POST is a GET, so a reload does not re-submit the save.
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
  // The session can lapse while this page sits open. It is its own outcome because the next
  // action is different from every other failure: sign in again, then the same button works.
  if (result.code === "unauthenticated") return back("signedout", workspaceId);
  if (result.code === "notFound") return back("gone", workspaceId);
  if (result.code === "conflict") {
    // "That is already saved in this case." and the rate limit both arrive as `conflict`, and
    // the action's own sentence is the only thing that separates them. If the wording ever
    // drifts this falls through to `busy`, whose copy is vaguer but not wrong.
    const already = result.message.toLowerCase().includes("already saved");
    return back(already ? "already" : "busy", workspaceId);
  }
  return back("failed", workspaceId);
}

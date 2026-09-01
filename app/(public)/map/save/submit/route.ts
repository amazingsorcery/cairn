import { addWorkspaceItem } from "@/lib/actions/workspaces";
import { logger } from "@/lib/logger";
import { requireSignInEnabled } from "@/lib/session-surface";

/**
 * `POST /map/save/submit` — the map save picker's form target.
 *
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION. The same reason as
 * `app/(public)/tools/[slug]/save/submit/route.ts`, whose header records the two Server Action
 * versions the E2E suite rejected: one lost a click that landed before hydration, the other
 * lost a save when the reader navigated away while the background `fetch` was in flight. A
 * native `<form method="post">` has neither window — the browser commits to the request before
 * it leaves the page, React never intercepts it, and it works with the bundle removed.
 *
 * IT WRITES NO SQL AND INVENTS NO ACTION. `addWorkspaceItem` re-checks the session,
 * rate-limits, Zod-validates, re-checks ownership inside its transaction, and resolves the
 * whole snapshot server-side from `lib/live/feature-cache.ts` — the attribution, the licence,
 * the source name and the title are read from what our own governed poll returned, never from
 * this form (ADR 0025, QA finding QV-14).
 *
 * The two feature fields here are a LOOKUP KEY into that cache, not a payload. The worst a
 * crafted pair can do is name a feature the cache does not hold, which fails the save.
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
 * every genuine save, which is what the first version of the tool-save handler did.
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

export async function POST(request: Request): Promise<Response> {
  /*
   * PUBLIC-ONLY MODE: no sign-in, so no cases, so nothing to write into. 404 before the body
   * is even read — an unauthenticated caller must not learn whether their payload was
   * well-formed on a surface this deployment does not offer. ADR 0032.
   */
  requireSignInEnabled();

  const form = await request.formData().catch(() => null);
  const workspaceId = form ? String(form.get("workspaceId") ?? "") : "";
  const sourceSlug = form ? String(form.get("source") ?? "") : "";
  const featureRef = form ? String(form.get("feature") ?? "") : "";

  /**
   * A RELATIVE `Location`, which browsers resolve against the address they used. An absolute
   * URL built from `request.url` would send the reader to the server's own binding — which is
   * how the tool-save handler once bounced `127.0.0.1` visitors to `localhost` and lost their
   * session cookie on the way.
   *
   * 303: the result of a POST is a GET, so a reload does not re-submit the save. The reader
   * lands back on the picker, still holding the same feature, with the list on screen.
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
  // The session can lapse while this page sits open. It is its own outcome because the next
  // action is different from every other failure: sign in again, then the same button works.
  if (result.code === "unauthenticated") return back("signedout");
  if (result.code === "notFound") return back("gone");
  if (result.code === "conflict") {
    // "That is already saved in this case." and the rate limit both arrive as `conflict`, and
    // the action's own sentence is the only thing that separates them. If the wording ever
    // drifts this falls through to `busy`, whose copy is vaguer but not wrong.
    const already = result.message.toLowerCase().includes("already saved");
    return back(already ? "already" : "busy");
  }
  return back("failed");
}

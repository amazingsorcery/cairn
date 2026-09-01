import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { consumeSafely } from "@/lib/rate-limit";
import { requireSignInEnabled } from "@/lib/session-surface";
import { getWorkspaceForExport } from "@/lib/queries/workspaces";
import { exportFormatSchema } from "@/lib/validation/workspaces";
import { toolFactsFor } from "../tool-facts";
import { buildCaseDocument, exportBasename } from "./document";
import { renderCaseMarkdown } from "./markdown";
import { renderCasePdf } from "./pdf";

/**
 * `GET /workspaces/[id]/export?format=md|pdf`.
 *
 * ORDER OF OPERATIONS IS THE SECURITY PROPERTY. Session, then a uuid shape check, then
 * ownership as a SQL predicate — and only then is a single byte of the case rendered.
 * `getWorkspaceForExport` binds `where id = $1 and user_id = $2`; a non-owner gets null and
 * therefore a 404, never a 403, because a 403 confirms the workspace exists (architecture
 * HANDOFF 11 assertion 2). Nothing about the case is read, buffered or logged before that
 * predicate has been satisfied.
 *
 * NO SIGNED TOKEN, NO SHARE LINK, AND NONE MAY BE ADDED. Ownership is re-checked on every
 * single request because a leaked export link is a leaked case file (sitemap.md 7).
 *
 * `private, no-store` and `X-Robots-Tag: noindex` are set on the response itself rather
 * than relied on from the edge: this handler returns a user's case file, and the header that
 * keeps it out of a shared cache should live next to the code that produces it.
 *
 * `?format` is parsed with `exportFormatSchema`, which is `.catch("md")` — a junk value
 * yields Markdown rather than a 400. The reader asked for their case file; giving them the
 * cheap format is a better answer than an error page.
 */

export const dynamic = "force-dynamic";
/** pdfkit is a Node library. It cannot run on the edge runtime and must not be moved there. */
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function privateHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
    "X-Robots-Tag": "noindex, nofollow",
    ...extra,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  /*
   * 0. Is there a signed-in surface at all? In public-only mode there is no sign-in to
   *    redirect to, so this download is not served — the same 404 the rest of `/workspaces`
   *    gives (ADR 0032). It is checked before the session so a leftover cookie cannot open
   *    an export path whose sign-out is no longer served.
   */
  requireSignInEnabled();

  // 1. Session. Signed out is a redirect to sign-in, per the route-level invariant in
  //    sitemap.md 10.2 — the same answer every other `/workspaces/**` path gives.
  const user = await currentUser();
  if (!user) {
    const target = `/signin?callbackUrl=${encodeURIComponent(`/workspaces/${id}`)}`;
    return NextResponse.redirect(new URL(target, request.url), { status: 302 });
  }

  // 2. Shape. A malformed id is a 404, not a 500 out of the uuid parser.
  if (!UUID.test(id)) {
    return new NextResponse("Not found", { status: 404, headers: privateHeaders({}) });
  }

  // 3. Ownership, in SQL. Nothing is rendered before this returns a row.
  const workspace = await getWorkspaceForExport(id, user.id);
  if (!workspace) {
    return new NextResponse("Not found", { status: 404, headers: privateHeaders({}) });
  }

  /**
   * 4. Rate limit — AFTER the ownership check, deliberately. QA finding Q-10.
   *
   * Rendering a PDF runs pdfkit in-process and was measured at 0.7–10.7 s per call, on a
   * box that also runs Postgres and Caddy (product-brief §5). Unbounded, a signed-in user
   * looping this is a denial of service against the whole deployment.
   *
   * The order matters: limiting BEFORE the ownership check would turn the limiter into an
   * existence oracle — a caller could distinguish "this workspace is not yours" from "you
   * are being throttled" and learn that the id is real. Behind the check, a non-owner always
   * gets the same 404 and never reaches the counter at all.
   *
   * `consumeSafely` fails open on a database error, which is right here: the export needs
   * the same database, so a failing limiter means the export was going to fail anyway.
   */
  const budget = await consumeSafely("workspace-export", user.id);
  if (!budget.ok) {
    const retryAfter = Math.max(1, Math.ceil((budget.resetAt.getTime() - Date.now()) / 1000));
    return new NextResponse("Too many exports. Try again shortly.", {
      status: 429,
      headers: privateHeaders({ "Retry-After": String(retryAfter) }),
    });
  }

  const format = exportFormatSchema.parse(new URL(request.url).searchParams.get("format"));
  // No query: confidence and last-verified come joined on the item rows (QA finding Q-15).
  const facts = toolFactsFor(workspace.savedTools);

  const caseDocument = buildCaseDocument(workspace, facts, new Date());
  const basename = exportBasename(caseDocument);

  if (format === "md") {
    return new NextResponse(renderCaseMarkdown(caseDocument), {
      status: 200,
      headers: privateHeaders({
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${basename}.md"`,
      }),
    });
  }

  try {
    const pdf = await renderCasePdf(caseDocument);
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: privateHeaders({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${basename}.pdf"`,
        "Content-Length": String(pdf.byteLength),
      }),
    });
  } catch (error) {
    // The case is untouched: this handler only reads. The dialog says so, and it is true.
    logger.error({ scope: "workspace.export.pdf", workspaceId: id, err: error }, "PDF export failed");
    return new NextResponse("Export failed", { status: 500, headers: privateHeaders({}) });
  }
}

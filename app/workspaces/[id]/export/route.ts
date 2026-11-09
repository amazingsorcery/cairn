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
 * Order matters: session, uuid check, then ownership in SQL before anything is rendered.
 * A non-owner gets 404, not 403, so existence isn't confirmed. No share links or signed
 * tokens: ownership is checked on every request.
 *
 * Cache and robots headers are set here rather than relying on the edge. A junk `?format`
 * falls back to Markdown.
 */

export const dynamic = "force-dynamic";
/** pdfkit needs Node; it can't run on the edge runtime. */
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

  // 0. Public-only mode: 404, checked before the session so a stale cookie can't get in.
  requireSignInEnabled();

  // 1. Session. Signed out redirects to sign-in, like the rest of `/workspaces/**`.
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
   * 4. Rate limit, since a PDF render takes up to ~10 s in-process. It runs after the
   * ownership check so a 429 vs 404 can't reveal that an id exists. Fails open on a DB
   * error; the export would fail anyway.
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
  // No query: confidence and last-verified come joined on the item rows.
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
    // Read-only handler, so the case is untouched.
    logger.error({ scope: "workspace.export.pdf", workspaceId: id, err: error }, "PDF export failed");
    return new NextResponse("Export failed", { status: 500, headers: privateHeaders({}) });
  }
}

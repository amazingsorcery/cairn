import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { adminMetadata, requireEditorPage } from "@/components/admin/guard";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import { publishTool, reverifyTool, unpublishTool } from "@/lib/actions/tools";
import { listToolsForAdmin } from "@/lib/queries/admin";
import { formatDate } from "@/lib/utils";

/**
 * `/admin/tools` — every tool, drafts included, newest edit first. sitemap.md §8.
 *
 * WHAT THIS PAGE DOES NOT DO: it does not edit. `/admin/tools/[id]` and `/admin/tools/new` are
 * in `sitemap.md` §8 and are NOT built in this pass — so, per product-brief §8, they are not
 * linked either. The controls here are the three that already have actions behind them
 * (publish, unpublish, confirm still accurate), and the gap is recorded in
 * `docs/frontend/HANDOFF-live.md` rather than papered over with a link to a 404.
 *
 * Publishing can be REFUSED by the database: `tools_published_requires_verification_check`
 * needs a verification date and a reliability rating. The refusal is surfaced next to the
 * button as the sentence `guard()` mapped it to; the constraint name never reaches the screen
 * (states.md §11.3).
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Tools",
      description: "The tool catalogue, drafts included.",
      path: "/admin/tools",
    },
    "editor",
  );
}

export default async function AdminToolsPage() {
  await requireEditorPage();
  const tools = await listToolsForAdmin();
  const today = formatDate(new Date());

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Tools</h1>
      <p className="mt-3 tabular text-sm text-foreground-secondary">
        {tools.length} {tools.length === 1 ? "entry" : "entries"} ·{" "}
        {tools.filter((t) => t.status === "published").length} published
      </p>

      {tools.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">The catalogue is empty</h2>
          <p className="mt-2 text-sm text-foreground-secondary">
            Entries are loaded from <span className="font-mono">content/tools/</span> by the seed
            script. Run it, or add the first entry directly.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <caption className="sr-only">
              Every tool in the catalogue, drafts included, most recently edited first.
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <Th>name</Th>
                <Th>status</Th>
                <Th>confidence</Th>
                <Th>reliability</Th>
                <Th>last verified</Th>
                <Th>updated</Th>
                <Th>actions</Th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id} className="border-b border-border last:border-0 align-top">
                  <th scope="row" className="px-3 py-3 text-left font-medium">
                    {tool.name}
                    <span className="block font-mono text-xs font-normal text-muted-foreground">
                      {tool.slug}
                    </span>
                  </th>
                  <td className="px-3 py-3">
                    {tool.status === "published" ? (
                      <Badge variant="success">published</Badge>
                    ) : (
                      <Badge variant="muted">draft</Badge>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <ConfidenceChipLink level={tool.confidence} showMeter={false} />
                  </td>
                  <td className="px-3 py-3 tabular">
                    {tool.reliability === null ? (
                      <span className="text-warning">not rated</span>
                    ) : (
                      `${tool.reliability}/5`
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <VerificationDate lastVerifiedAt={tool.lastVerifiedAt} />
                  </td>
                  <td className="px-3 py-3 tabular text-muted-foreground">
                    <time dateTime={tool.updatedAt.toISOString().slice(0, 10)}>
                      {formatDate(tool.updatedAt)}
                    </time>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-2">
                      <ConfirmAction
                        action={reverifyTool}
                        id={tool.id}
                        triggerLabel="confirm still accurate"
                        triggerVariant="secondary"
                        title="Confirm this entry is still accurate?"
                        description={
                          <>
                            This records that you checked{" "}
                            <strong className="text-foreground">{tool.name}</strong> against its
                            primary source today, {today}. It does not change the entry&rsquo;s
                            confidence level.
                          </>
                        }
                        confirmLabel="confirm"
                      />
                      {tool.status === "published" ? (
                        <ActionButton
                          action={unpublishTool}
                          id={tool.id}
                          label="unpublish"
                          variant="outline"
                        />
                      ) : (
                        <ActionButton action={publishTool} id={tool.id} label="publish" />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-6 max-w-[68ch] text-sm text-foreground-secondary">
        A published entry is visible at <span className="font-mono">/tools/&lt;slug&gt;</span>. A
        draft 404s for everyone but an editor —{" "}
        <Link href="/methodology" className="underline underline-offset-4 hover:text-foreground">
          what the confidence and verification values promise
        </Link>
        .
      </p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
      {children}
    </th>
  );
}

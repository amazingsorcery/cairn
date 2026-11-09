import { ActionButton } from "@/components/admin/action-button";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { adminMetadata, requireEditorPage } from "@/components/admin/guard";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import { publishPlaybook, reverifyPlaybook, unpublishPlaybook } from "@/lib/actions/playbooks";
import { listPlaybooksForAdmin } from "@/lib/queries/admin";
import { formatDate } from "@/lib/utils";

/**
 * `/admin/playbooks`. Step editing and reordering (`/admin/playbooks/[id]`) isn't built
 * yet, so it isn't linked.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Playbooks",
      description: "The playbook catalogue, drafts included.",
      path: "/admin/playbooks",
    },
    "editor",
  );
}

export default async function AdminPlaybooksPage() {
  await requireEditorPage();
  const playbooks = await listPlaybooksForAdmin();
  const today = formatDate(new Date());

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Playbooks</h1>
      <p className="mt-3 tabular text-sm text-foreground-secondary">
        {playbooks.length} {playbooks.length === 1 ? "entry" : "entries"} ·{" "}
        {playbooks.filter((p) => p.status === "published").length} published
      </p>

      {playbooks.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">No playbooks yet</h2>
          <p className="mt-2 text-sm text-foreground-secondary">
            Playbooks are loaded from <span className="font-mono">content/playbooks/</span> by
            the seed script.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <caption className="sr-only">
              Every playbook, drafts included, most recently edited first.
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <Th>title</Th>
                <Th>status</Th>
                <Th>confidence</Th>
                <Th>last verified</Th>
                <Th>updated</Th>
                <Th>actions</Th>
              </tr>
            </thead>
            <tbody>
              {playbooks.map((playbook) => (
                <tr key={playbook.id} className="border-b border-border align-top last:border-0">
                  <th scope="row" className="px-3 py-3 text-left font-medium">
                    {playbook.title}
                    <span className="block font-mono text-xs font-normal text-muted-foreground">
                      {playbook.slug}
                    </span>
                  </th>
                  <td className="px-3 py-3">
                    {playbook.status === "published" ? (
                      <Badge variant="success">published</Badge>
                    ) : (
                      <Badge variant="muted">draft</Badge>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <ConfidenceChipLink level={playbook.confidence} showMeter={false} />
                  </td>
                  <td className="px-3 py-3">
                    <VerificationDate lastVerifiedAt={playbook.lastVerifiedAt} />
                  </td>
                  <td className="px-3 py-3 tabular text-muted-foreground">
                    <time dateTime={playbook.updatedAt.toISOString().slice(0, 10)}>
                      {formatDate(playbook.updatedAt)}
                    </time>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-2">
                      <ConfirmAction
                        action={reverifyPlaybook}
                        id={playbook.id}
                        triggerLabel="confirm still accurate"
                        triggerVariant="secondary"
                        title="Confirm this entry is still accurate?"
                        description={
                          <>
                            This records that you checked{" "}
                            <strong className="text-foreground">{playbook.title}</strong> against
                            its primary source today, {today}. It does not change the
                            entry&rsquo;s confidence level.
                          </>
                        }
                        confirmLabel="confirm"
                      />
                      {playbook.status === "published" ? (
                        <ActionButton
                          action={unpublishPlaybook}
                          id={playbook.id}
                          label="unpublish"
                          variant="outline"
                        />
                      ) : (
                        <ActionButton action={publishPlaybook} id={playbook.id} label="publish" />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

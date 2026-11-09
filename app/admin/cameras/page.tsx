import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { adminMetadata, requireEditorPage } from "@/components/admin/guard";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Badge } from "@/components/ui/badge";
import { publishCamera, reverifyCamera, unpublishCamera } from "@/lib/actions/connectors";
import { listCamerasForAdmin } from "@/lib/queries/admin";
import { formatDate } from "@/lib/utils";

/**
 * `/admin/cameras`, editor level. A published camera that embeds must have a connector with
 * a recorded legal basis and an embed URL (`cameras_embed_*_check` constraints); the DB
 * refuses otherwise and the error shows next to the button.
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Cameras",
      description: "The camera registry, drafts included.",
      path: "/admin/cameras",
    },
    "editor",
  );
}

export default async function AdminCamerasPage() {
  await requireEditorPage();
  const cameras = await listCamerasForAdmin();
  const today = formatDate(new Date());

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Cameras</h1>
      <p className="mt-3 tabular text-sm text-foreground-secondary">
        {cameras.length} {cameras.length === 1 ? "entry" : "entries"} ·{" "}
        {cameras.filter((c) => c.status === "published").length} published ·{" "}
        {cameras.filter((c) => c.embedPermitted).length} embed, the rest link out
      </p>

      {cameras.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">The registry is empty</h2>
          <p className="mt-2 text-sm text-foreground-secondary">
            Entries are loaded from <span className="font-mono">content/cameras/</span> by the
            seed script. Adding a provider also regenerates{" "}
            <span className="font-mono">infra/csp.caddy</span>, which is committed so a widened
            image allowlist appears in review.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <caption className="sr-only">
              Every camera in the registry, drafts included, most recently edited first.
            </caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <Th>name</Th>
                <Th>status</Th>
                <Th>where</Th>
                <Th>embed</Th>
                <Th>confidence</Th>
                <Th>last verified</Th>
                <Th>actions</Th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((camera) => (
                <tr key={camera.id} className="border-b border-border align-top last:border-0">
                  <th scope="row" className="px-3 py-3 text-left font-medium">
                    {camera.status === "published" ? (
                      <Link
                        href={`/live/cameras/${camera.slug}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {camera.name}
                      </Link>
                    ) : (
                      camera.name
                    )}
                    <span className="block font-mono text-xs font-normal text-muted-foreground">
                      {camera.slug}
                    </span>
                  </th>
                  <td className="px-3 py-3">
                    {camera.status === "published" ? (
                      <Badge variant="success">published</Badge>
                    ) : (
                      <Badge variant="muted">draft</Badge>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <Badge variant="muted">{camera.jurisdiction}</Badge>{" "}
                    <Badge variant="outline">{camera.viewKind}</Badge>
                  </td>
                  <td className="px-3 py-3">
                    {camera.embedPermitted ? (
                      <Badge variant="outline">embeds</Badge>
                    ) : (
                      <span className="text-muted-foreground">links out</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <ConfidenceChipLink level={camera.confidence} showMeter={false} />
                  </td>
                  <td className="px-3 py-3">
                    <VerificationDate lastVerifiedAt={camera.lastVerifiedAt} />
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-2">
                      <ConfirmAction
                        action={reverifyCamera}
                        id={camera.id}
                        triggerLabel="confirm still accurate"
                        triggerVariant="secondary"
                        title="Confirm this entry is still accurate?"
                        description={
                          <>
                            This records that you checked{" "}
                            <strong className="text-foreground">{camera.name}</strong> against its
                            primary source today, {today}. It does not change the entry&rsquo;s
                            confidence level.
                          </>
                        }
                        confirmLabel="confirm"
                      />
                      {camera.status === "published" ? (
                        <ActionButton
                          action={unpublishCamera}
                          id={camera.id}
                          label="unpublish"
                          variant="outline"
                        />
                      ) : (
                        <ActionButton action={publishCamera} id={camera.id} label="publish" />
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

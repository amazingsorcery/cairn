import { ConfirmAction } from "@/components/admin/confirm-action";
import { adminMetadata, requireEditorPage } from "@/components/admin/guard";
import { QueueTable } from "@/components/admin/queue-table";
import { QueueTabs, type QueuePanel } from "@/components/admin/queue-tabs";
import { recheckConnector, reverifyCamera } from "@/lib/actions/connectors";
import { reverifyPlaybook } from "@/lib/actions/playbooks";
import { reverifyTool } from "@/lib/actions/tools";
import { getVerificationQueue, type QueueEntry } from "@/lib/queries/admin";
import { formatDate } from "@/lib/utils";

/**
 * `/admin/queue` — the staleness queue. A REQUIRED v1 route (architecture HANDOFF §9.5,
 * ADR 0007 §7): "without a route that makes decay visible to an editor, `lastVerifiedAt`
 * becomes a fossil within a quarter", which would make the whole confidence mechanism
 * decorative.
 *
 * THE ROW ACTION IS NOT PART OF SAVING AN EDIT, and that separation is the point of the
 * route. `updateTool`, `updateCamera` and their siblings never touch `last_verified_at`;
 * only `reverifyTool`, `reverifyCamera`, `reverifyPlaybook` and `recheckConnector` do, and
 * each sets it to `now()` rather than accepting a date from the caller. Coupling them would
 * let a typo fix silently assert that every claim on the page had been re-checked — the
 * back-dating dishonesty product-brief §6.3 forbids, in the other direction (ADR 0007 §8).
 */

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return adminMetadata(
    {
      title: "Verification queue",
      description: "Entries whose verification date has aged past the editorial threshold.",
      path: "/admin/queue",
    },
    "editor",
  );
}

/** ADR 0007 §5's stated starting value, and the number `states.md` §11.1 writes. */
const STALE_AFTER_DAYS = 180;

function daysSince(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function needsAttention(entry: QueueEntry): boolean {
  const days = daysSince(entry.lastVerifiedAt);
  return days === null || days > STALE_AFTER_DAYS;
}

export default async function AdminQueuePage() {
  const user = await requireEditorPage();
  const queue = await getVerificationQueue();

  const attention = queue.filter(needsAttention);
  const neverVerified = attention.filter((e) => e.lastVerifiedAt === null).length;
  const overdue = attention.length - neverVerified;

  const tools = attention.filter((e) => e.kind === "tool");
  const playbooks = attention.filter((e) => e.kind === "playbook");
  const cameras = attention.filter((e) => e.kind === "camera");
  const connectors = attention.filter((e) => e.kind === "connector");

  const today = formatDate(new Date());

  /** The wording of the claim an editor is about to make. It is a claim, so it is precise. */
  const reverifyDescription = (title: string) => (
    <>
      This records that you checked <strong className="text-foreground">{title}</strong> against
      its primary source today, {today}. It does not change the entry&rsquo;s confidence level.
    </>
  );

  const panels: QueuePanel[] = [
    {
      value: "tools",
      label: "tools",
      count: tools.length,
      content:
        tools.length === 0 ? (
          <EmptyList thing="tools" />
        ) : (
          <QueueTable
            caption={`Tools needing verification, oldest first. ${tools.length} entries.`}
            entries={tools}
            renderAction={(entry) => (
              <ConfirmAction
                action={reverifyTool}
                id={entry.id}
                triggerLabel="confirm still accurate"
                title="Confirm this entry is still accurate?"
                description={reverifyDescription(entry.title)}
                confirmLabel="confirm"
              />
            )}
          />
        ),
    },
    {
      value: "playbooks",
      label: "playbooks",
      count: playbooks.length,
      content:
        playbooks.length === 0 ? (
          <EmptyList thing="playbooks" />
        ) : (
          <QueueTable
            caption={`Playbooks needing verification, oldest first. ${playbooks.length} entries.`}
            entries={playbooks}
            renderAction={(entry) => (
              <ConfirmAction
                action={reverifyPlaybook}
                id={entry.id}
                triggerLabel="confirm still accurate"
                title="Confirm this entry is still accurate?"
                description={reverifyDescription(entry.title)}
                confirmLabel="confirm"
              />
            )}
          />
        ),
    },
    {
      value: "cameras",
      label: "cameras",
      count: cameras.length,
      content:
        cameras.length === 0 ? (
          <EmptyList thing="cameras" />
        ) : (
          <QueueTable
            caption={`Cameras needing verification, oldest first. ${cameras.length} entries.`}
            entries={cameras}
            renderAction={(entry) => (
              <ConfirmAction
                action={reverifyCamera}
                id={entry.id}
                triggerLabel="confirm still accurate"
                title="Confirm this entry is still accurate?"
                description={reverifyDescription(entry.title)}
                confirmLabel="confirm"
              />
            )}
          />
        ),
    },
    {
      value: "connectors",
      label: "connectors",
      count: connectors.length,
      content:
        connectors.length === 0 ? (
          <EmptyList thing="connectors" />
        ) : (
          <QueueTable
            caption={`Connectors whose terms need re-reading, oldest first. ${connectors.length} entries.`}
            entries={connectors}
            showConfidence={false}
            dateHeading="terms last read"
            renderAction={(entry) =>
              /*
               * `recheckConnector` requires the `admin` role, so an editor is not offered a
               * control that would refuse them. The action re-checks the role regardless —
               * a hidden button is not authorisation.
               */
              user.role === "admin" ? (
                <ConfirmAction
                  action={recheckConnector}
                  id={entry.id}
                  triggerLabel="confirm terms unchanged"
                  title={"Confirm this source’s terms are unchanged?"}
                  description={
                    <>
                      This records that you read {entry.title}&rsquo;s licence or terms of
                      service today, {today}, and found them unchanged. It does not enable or
                      publish the connector.
                    </>
                  }
                  confirmLabel="confirm"
                />
              ) : (
                <span className="text-sm text-muted-foreground">
                  an admin re-reads connector terms
                </span>
              )
            }
          />
        ),
    },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Verification queue</h1>

      {attention.length === 0 ? (
        <div className="mt-6 max-w-[68ch] rounded-lg border border-border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">Nothing in the queue</h2>
          <p className="mt-2 text-sm text-foreground-secondary">
            Every published entry has been verified within {STALE_AFTER_DAYS} days.
          </p>
        </div>
      ) : (
        <>
          <p className="mt-3 tabular text-lg text-foreground-secondary">
            {attention.length} {attention.length === 1 ? "entry needs" : "entries need"} attention
          </p>
          <p className="mt-1 tabular text-sm text-foreground-secondary">
            {neverVerified} {neverVerified === 1 ? "has" : "have"} never been verified ·{" "}
            {overdue} {overdue === 1 ? "was" : "were"} last verified more than {STALE_AFTER_DAYS}{" "}
            days ago
          </p>
          <QueueTabs panels={panels} />
        </>
      )}
    </div>
  );
}

function EmptyList({ thing }: { thing: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <p className="text-sm text-foreground-secondary">
        No {thing} are past the {STALE_AFTER_DAYS}-day threshold.
      </p>
    </div>
  );
}

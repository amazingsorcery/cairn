import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { WorkspaceStatus } from "@/db/schema";
import type { WorkspaceSummary } from "@/lib/queries/workspaces";
import { formatDate } from "@/lib/utils";
import { isoDate } from "./dates";

/**
 * One case on `/workspaces`, with progress counts. The status badge stays neutral; an
 * archived case is not a warning.
 */

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  active: "active",
  completed: "completed",
  archived: "archived",
};

export function CaseCard({ workspace }: { workspace: WorkspaceSummary }) {
  return (
    <Card className="transition-colors hover:border-ring motion-reduce:transition-none">
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-lg font-semibold leading-tight tracking-tight">
            <Link
              href={`/workspaces/${workspace.id}`}
              className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {workspace.title}
            </Link>
          </h2>
          <Badge variant={workspace.status === "active" ? "outline" : "muted"}>
            {STATUS_LABEL[workspace.status]}
          </Badge>
        </div>

        <p className="tabular text-sm text-foreground-secondary">
          started{" "}
          <time dateTime={isoDate(workspace.createdAt)}>{formatDate(workspace.createdAt)}</time>
          {" · "}
          last touched{" "}
          <time dateTime={isoDate(workspace.updatedAt)}>{formatDate(workspace.updatedAt)}</time>
        </p>

        {workspace.playbookSlug && workspace.playbookTitle ? (
          <p className="text-sm text-foreground-secondary">
            from{" "}
            <Link
              href={`/playbooks/${workspace.playbookSlug}`}
              className="text-primary underline underline-offset-4"
            >
              {workspace.playbookTitle}
              <ArrowRight className="ml-1 inline size-3.5" aria-hidden="true" />
            </Link>
          </p>
        ) : workspace.playbookTitle ? (
          // Playbook unpublished or deleted: keep the title, drop the link.
          <p className="text-sm text-foreground-secondary">from {workspace.playbookTitle}</p>
        ) : null}

        <ul className="tabular flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <li>
            {workspace.checkedCount}/{workspace.itemCount} checklist
          </li>
          <li>{workspace.noteCount === 1 ? "1 note" : `${workspace.noteCount} notes`}</li>
        </ul>
      </CardContent>
    </Card>
  );
}

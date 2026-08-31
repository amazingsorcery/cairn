import { notFound } from "next/navigation";
import Link from "next/link";

import { Checklist } from "@/components/workspaces/checklist";
import { NoteComposer } from "@/components/workspaces/note-composer";
import { NoteCard } from "@/components/workspaces/note-card";
import { Region } from "@/components/workspaces/region";
import { SavedTools } from "@/components/workspaces/saved-tools";
import { WorkspaceHeader } from "@/components/workspaces/workspace-header";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { pageMetadata } from "@/lib/metadata";
import { getWorkspace, type NoteView } from "@/lib/queries/workspaces";
import { requireSession } from "../session";
import { loadToolFacts } from "./tool-facts";

/**
 * `/workspaces/[id]` — the whole case on ONE page.
 *
 * Three regions, not three routes (sitemap.md 7): splitting them would triple the round
 * trips for a view whose entire value is having the case in front of you at once.
 *
 * A NON-OWNER GETS 404, NOT 403 (architecture HANDOFF 11 assertion 2). `getWorkspace` binds
 * `where id = $1 and user_id = $2` and returns null for both "does not exist" and "is not
 * yours", which are deliberately the same answer: a 403 confirms the workspace exists, and
 * for an audience whose cases are the sensitive thing that is an enumeration oracle. The
 * ownership decision is a SQL predicate, never a TypeScript comparison after a fetch.
 *
 * `force-dynamic`, never cached at any layer, `noindex`. A user's case file must not touch
 * a shared cache, a CDN or the ISR filesystem cache.
 *
 * NOTES APPEAR EXACTLY ONCE. A note anchored to a checklist entry is rendered inside that
 * entry, where it is useful while working the step; the notes region holds the case-level
 * ones and states how many are attached elsewhere. Rendering both lists in full would give
 * the same note two editors and two save indicators.
 */

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({
  title: "Case",
  description: "A case workspace: checklist, saved tools and timestamped notes.",
  path: "/workspaces",
  index: false,
});

export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireSession(`/workspaces/${id}`);

  // A malformed id must be a 404, not a 500 from the driver's uuid parser.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  const workspace = await getWorkspace(id, user.id);
  if (!workspace) notFound();

  const facts = await loadToolFacts(
    workspace.savedTools.map((item) => item.toolSlug).filter((slug): slug is string => slug !== null),
  );

  const notesByItem: Record<string, NoteView[]> = {};
  const caseNotes: NoteView[] = [];
  for (const note of workspace.notes) {
    if (note.workspaceItemId) {
      (notesByItem[note.workspaceItemId] ??= []).push(note);
    } else {
      caseNotes.push(note);
    }
  }
  const anchoredCount = workspace.notes.length - caseNotes.length;

  const checkedCount = workspace.checklist.filter((item) => item.checked).length;
  const allDone = workspace.checklist.length > 0 && checkedCount === workspace.checklist.length;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[{ label: "your cases", href: "/workspaces" }, { label: workspace.title }]}
      />

      <div className="mt-6">
        <WorkspaceHeader
          workspaceId={workspace.id}
          title={workspace.title}
          status={workspace.status}
          createdAt={workspace.createdAt}
          playbook={workspace.playbook}
          counts={{
            notes: workspace.notes.length,
            tools: workspace.savedTools.length,
            steps: workspace.checklist.length,
          }}
        />
      </div>

      {/* One polite live region for the route (HANDOFF-shell 10.1). */}
      <p aria-live="polite" className="sr-only">
        {`${checkedCount} of ${workspace.checklist.length} checklist steps done, ${workspace.savedTools.length} saved tools, ${workspace.notes.length} notes`}
      </p>

      {allDone && workspace.status === "active" ? (
        <p className="mt-6 rounded-md border border-success/40 bg-success-surface px-4 py-3 text-sm">
          Every step is ticked. Mark the case completed from the actions menu when you are
          satisfied it is finished — nothing does that for you.
        </p>
      ) : null}

      <div className="mt-8 grid gap-6 xl:grid-cols-3">
        <Region
          title="Checklist"
          count={`${checkedCount}/${workspace.checklist.length}`}
          countLabel="steps done"
        >
          <Checklist
            workspaceId={workspace.id}
            items={workspace.checklist}
            notesByItem={notesByItem}
            playbookSlug={workspace.playbook?.slug ?? null}
          />
        </Region>

        <Region
          title="Saved tools"
          count={String(workspace.savedTools.length)}
          countLabel="saved tools"
        >
          <SavedTools items={workspace.savedTools} facts={facts} />
        </Region>

        <Region title="Notes" count={String(caseNotes.length)} countLabel="case notes">
          <div className="p-4">
            <NoteComposer
              workspaceId={workspace.id}
              label="add a note to this case"
              placeholder="what you found, and where"
            />

            {anchoredCount > 0 ? (
              <p className="mt-4 text-xs text-muted-foreground">
                {anchoredCount === 1
                  ? "1 more note is attached to a checklist step."
                  : `${anchoredCount} more notes are attached to checklist steps.`}
              </p>
            ) : null}

            {caseNotes.length === 0 ? (
              <p className="mt-4 text-sm leading-relaxed text-foreground-secondary">
                No notes yet. Notes are timestamped as you write them.
              </p>
            ) : (
              <ul className="mt-4 flex flex-col gap-3">
                {caseNotes.map((note) => (
                  <li key={note.id}>
                    <NoteCard note={note} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Region>
      </div>

      <p className="mt-8 max-w-[68ch] text-xs leading-relaxed text-muted-foreground">
        This case is yours. It is never indexed, never shared, and never used to rank
        anything. Confidence chips and verification dates above are read live from the
        catalogue, so they change when our record of a tool changes — the titles you saved do
        not. Read{" "}
        <Link href="/methodology" className="text-primary underline underline-offset-4">
          the methodology
        </Link>{" "}
        for what each of those means.
      </p>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Archive, CircleCheck, MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteWorkspace, updateWorkspace } from "@/lib/actions/workspaces";
import type { WorkspaceStatus } from "@/db/schema";
import { formatDate } from "@/lib/utils";
import { isoDate } from "./dates";
import { ExportDialog } from "./export-dialog";
import { SaveIndicator, type SaveState } from "./save-indicator";
import { useUnsavedGuard } from "./use-unsaved-guard";

/**
 * The case header: title, status, provenance, and the two destructive doors.
 *
 * THE TITLE AUTOSAVES ON PAUSE AND ON BLUR, exactly as `flows.md` M1 specifies for it —
 * "notes and the workspace title save 800 ms after typing stops and on blur" — with the
 * same three-state text indicator and the same `beforeunload` guard as a note. It is less
 * work than a note and still work.
 *
 * MARK COMPLETED IS OFFERED, NEVER AUTOMATIC (`flows.md` 3, step 10). The user decides when
 * a case is finished; a checklist reaching 9/9 is evidence, not a verdict.
 *
 * DELETING REQUIRES TYPING THE CASE TITLE (`states.md` 7.9). It cascades to every note and
 * item the user has and there is no soft delete in the schema, so the confirmation names
 * exactly what is about to go and the button stays disabled until the title matches. Cancel
 * carries initial focus.
 */

const AUTOSAVE_DELAY_MS = 800;

export interface WorkspaceHeaderProps {
  workspaceId: string;
  title: string;
  status: WorkspaceStatus;
  createdAt: Date | string;
  playbook: { slug: string; title: string } | null;
  counts: { notes: number; tools: number; steps: number };
}

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  active: "active",
  completed: "completed",
  archived: "archived",
};

export function WorkspaceHeader({
  workspaceId,
  title,
  status,
  createdAt,
  playbook,
  counts,
}: WorkspaceHeaderProps) {
  const router = useRouter();
  const titleFieldId = useId();

  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(title);
  const [saved, setSaved] = useState(title);
  const [state, setState] = useState<SaveState>({ status: "clean" });

  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const dirty = value.trim() !== saved.trim() && value.trim() !== "";
  useUnsavedGuard(dirty);

  const save = useCallback(
    async (next: string, nextStatus: WorkspaceStatus = status) => {
      const candidate = next.trim();
      if (candidate === "" || inFlight.current) return;
      if (candidate === saved.trim() && nextStatus === status) return;
      inFlight.current = true;
      setState({ status: "saving" });

      const result = await updateWorkspace({ id: workspaceId, title: candidate, status: nextStatus });
      inFlight.current = false;

      if (!result.ok) {
        setState({
          status: "failed",
          message:
            result.code === "unauthenticated"
              ? "you were signed out. Sign back in — your text is still here."
              : result.message,
        });
        return;
      }

      setSaved(candidate);
      setState({ status: "saved", at: new Date() });
      router.refresh();
    },
    [workspaceId, saved, status, router],
  );

  useEffect(() => {
    if (!renaming || !dirty) return;
    setState((current) => (current.status === "failed" ? current : { status: "dirty" }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(value), AUTOSAVE_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, dirty, renaming, save]);

  async function onDelete() {
    setDeleteError(null);
    const result = await deleteWorkspace({ id: workspaceId });
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    router.replace("/workspaces");
  }

  const createdIso = isoDate(createdAt);
  const canDelete = confirmText.trim() === saved.trim() && confirmText.trim() !== "";

  return (
    <header>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="max-w-[52ch]">
              <Label htmlFor={titleFieldId} className="sr-only">
                case name
              </Label>
              <Input
                id={titleFieldId}
                value={value}
                maxLength={160}
                onChange={(event) => setValue(event.target.value)}
                onBlur={() => {
                  if (timer.current) clearTimeout(timer.current);
                  void save(value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (timer.current) clearTimeout(timer.current);
                    void save(value).then(() => setRenaming(false));
                  }
                }}
                className="h-11 text-xl font-semibold"
              />
              <div className="mt-2 flex items-center gap-3">
                <SaveIndicator state={state} onRetry={() => void save(value)} />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-11"
                  onClick={() => {
                    if (timer.current) clearTimeout(timer.current);
                    void save(value).then(() => setRenaming(false));
                  }}
                >
                  done
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{saved}</h1>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="rename this case"
                onClick={() => setRenaming(true)}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </Button>
            </div>
          )}

          <p className="tabular mt-1 text-sm text-foreground-secondary">
            {STATUS_LABEL[status]} · started{" "}
            <time dateTime={createdIso}>{formatDate(createdAt)}</time>
          </p>

          {playbook ? (
            <p className="mt-1 text-sm text-foreground-secondary">
              from{" "}
              <Link
                href={`/playbooks/${playbook.slug}`}
                className="text-primary underline underline-offset-4"
              >
                {playbook.title}
              </Link>
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" className="h-11" onClick={() => setExporting(true)}>
            export
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="more actions for this case">
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {status !== "completed" ? (
                <DropdownMenuItem onSelect={() => void save(saved, "completed")}>
                  <CircleCheck aria-hidden="true" />
                  mark completed
                </DropdownMenuItem>
              ) : null}
              {status !== "active" ? (
                <DropdownMenuItem onSelect={() => void save(saved, "active")}>
                  <RotateCcw aria-hidden="true" />
                  reopen as active
                </DropdownMenuItem>
              ) : null}
              {status !== "archived" ? (
                <DropdownMenuItem onSelect={() => void save(saved, "archived")}>
                  <Archive aria-hidden="true" />
                  archive
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => setDeleting(true)}>
                <Trash2 aria-hidden="true" />
                delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        workspaceId={workspaceId}
        counts={counts}
      />

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent closeLabel="keep this case">
          <DialogHeader>
            <DialogTitle>Delete this case?</DialogTitle>
            <DialogDescription>
              {saved} · {counts.notes} {counts.notes === 1 ? "note" : "notes"} ·{" "}
              {counts.tools} saved {counts.tools === 1 ? "tool" : "tools"} · {counts.steps}{" "}
              checklist {counts.steps === 1 ? "step" : "steps"}. This cannot be undone and the
              notes are not recoverable.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 flex flex-col gap-1.5">
            <Label htmlFor={`${titleFieldId}-confirm`}>type the case title to confirm</Label>
            <Input
              id={`${titleFieldId}-confirm`}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              className="h-11"
              autoComplete="off"
              placeholder={saved}
            />
          </div>

          {deleteError ? (
            <p role="status" className="mt-3 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" autoFocus onClick={() => setDeleting(false)}>
              cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!canDelete}
              onClick={() => void onDelete()}
            >
              delete this case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

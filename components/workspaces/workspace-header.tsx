"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
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

/**
 * Q-12. `ExportDialog` pulls Radix Dialog and the format chooser in behind it, and this
 * header renders on every case page — so a statically imported dialog put 54.7 kB of route
 * chunk (219 kB First Load) on the one route a researcher sits on for hours, often on a bad
 * connection in the field, whether or not they ever export anything.
 *
 * Loaded on demand instead, and mounted only once `exporting` is true. Same pattern, and the
 * same reason, as `components/live/flights-surface.tsx` deferring its Leaflet map.
 *
 * `ssr: false` is correct rather than merely convenient: the dialog is closed on the server
 * in every render that matters, so there is nothing to prerender, and it reaches for
 * `window` (`URL.createObjectURL`, an `<a download>`) the moment it does anything.
 */
const ExportDialog = dynamic(
  () => import("./export-dialog").then((module) => module.ExportDialog),
  { ssr: false },
);

const AUTOSAVE_DELAY_MS = 800;

export interface WorkspaceHeaderProps {
  workspaceId: string;
  title: string;
  status: WorkspaceStatus;
  createdAt: Date | string;
  playbook: { slug: string; title: string } | null;
  /**
   * `features` is the count of map features saved into the case (ADR 0025). It is rendered
   * only when it is non-zero, so the delete confirmation keeps exactly the wording
   * `states.md` 7.9 specifies for every case that has none.
   */
  counts: { notes: number; tools: number; steps: number; features: number };
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

  /**
   * Q-09 — WCAG 2.4.3. Opening the rename form REPLACES its own trigger, so without this the
   * browser has nowhere to put focus and drops it on `<body>`: a keyboard user asks to rename
   * the case and is returned to the top of the document, with the whole header and nav to
   * traverse before reaching the field they just asked for.
   *
   * `renameButtonRef` is the trigger and `titleInputRef` is what replaces it. Focus moves
   * into the input when the mode opens and back to the trigger when it closes — the trigger
   * is remounted by then, which is why the restore runs in an effect keyed on `renaming`
   * rather than inside the click handler.
   *
   * `exportButtonRef` is passed to the dialog, which returns focus to it on close (Radix's
   * own restore cannot find the trigger because the dialog is driven by controlled state
   * rather than by `DialogTrigger`).
   */
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);

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
    if (renaming) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    } else if (wasRenaming.current) {
      // Only on the close transition, never on first mount — stealing focus on load would
      // be its own defect.
      renameButtonRef.current?.focus();
    }
    wasRenaming.current = renaming;
  }, [renaming]);

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
          {/*
            Q-13 — WCAG 1.3.1. The `h1` is mounted in BOTH modes. Renaming used to swap it out
            for a bare input, leaving `/workspaces/[id]` with no level-one heading at all: a
            screen-reader user navigating by heading lost the document's identity at exactly
            the moment they were editing it. While renaming, the `h1` carries the current
            title visually-hidden and wraps the field, so the outline survives the interaction
            and the input is still labelled by its own `<label>`.
          */}
          {renaming ? (
            <div className="max-w-[52ch]">
              <h1 className="sr-only">{saved}</h1>
              <Label htmlFor={titleFieldId} className="sr-only">
                case name
              </Label>
              <Input
                ref={titleInputRef}
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
                ref={renameButtonRef}
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
          <Button
            ref={exportButtonRef}
            type="button"
            className="h-11"
            onClick={() => setExporting(true)}
          >
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

      {exporting ? (
        <ExportDialog
          open
          onOpenChange={setExporting}
          workspaceId={workspaceId}
          counts={counts}
          returnFocusTo={exportButtonRef}
        />
      ) : null}

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent closeLabel="keep this case">
          <DialogHeader>
            <DialogTitle>Delete this case?</DialogTitle>
            <DialogDescription>
              {saved} · {counts.notes} {counts.notes === 1 ? "note" : "notes"} ·{" "}
              {counts.tools} saved {counts.tools === 1 ? "tool" : "tools"} · {counts.steps}{" "}
              checklist {counts.steps === 1 ? "step" : "steps"}
              {counts.features > 0
                ? ` · ${counts.features} saved map ${counts.features === 1 ? "feature" : "features"}, which cannot be saved again because the sources keep no history`
                : ""}
              . This cannot be undone and the
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

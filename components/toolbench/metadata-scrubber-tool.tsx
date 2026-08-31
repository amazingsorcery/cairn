"use client";

import * as React from "react";
import { Download, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkFileSize, formatBytes, IMAGE_GATE } from "@/lib/toolbench/files";
import { hashBytes } from "@/lib/toolbench/hashing";
import { stripMetadata, type StripResult } from "@/lib/toolbench/strip-metadata";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * The scrubber.
 *
 * The output is produced in the browser and handed back through a `blob:` URL, so the file
 * never reaches a server in either direction. That is not only a privacy property: a
 * publishing workflow that requires uploading the unredacted original to a scrubbing service
 * has not removed the disclosure, it has moved it.
 *
 * The two hashes shown afterwards are there because a scrubbed file is a *different file*.
 * If the original was logged in a chain of custody, the published one needs its own entry,
 * and the pair of digests is what connects them.
 */

interface ScrubOutcome {
  readonly fileName: string;
  readonly originalSize: number;
  readonly result: StripResult;
  readonly downloadUrl: string;
  readonly downloadName: string;
  readonly originalSha256: string;
  readonly scrubbedSha256: string;
}

function suggestName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName}-scrubbed`;
  return `${fileName.slice(0, dot)}-scrubbed${fileName.slice(dot)}`;
}

export function MetadataScrubberTool() {
  return (
    <Announcer>
      <MetadataScrubberToolInner />
    </Announcer>
  );
}

function MetadataScrubberToolInner() {
  const announce = useAnnounce();
  const [outcome, setOutcome] = React.useState<ScrubOutcome | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const urlRef = React.useRef<string | null>(null);

  React.useEffect(
    () => () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const scrub = React.useCallback(
    async (file: File) => {
      setError(null);
      const size = checkFileSize(file.size, IMAGE_GATE);
      if (!size.ok) {
        setError(size.error);
        return;
      }
      setBusy(true);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const stripped = stripMetadata(bytes);
        if (!stripped.ok) {
          setError(stripped.error);
          setOutcome(null);
          return;
        }

        const [originalSha256, scrubbedSha256] = await Promise.all([
          hashBytes("SHA-256", bytes),
          hashBytes("SHA-256", stripped.value.bytes),
        ]);

        if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
        const blob = new Blob([stripped.value.bytes.slice()], {
          type: stripped.value.container === "jpeg" ? "image/jpeg" : "image/png",
        });
        const downloadUrl = URL.createObjectURL(blob);
        urlRef.current = downloadUrl;

        setOutcome({
          fileName: file.name,
          originalSize: file.size,
          result: stripped.value,
          downloadUrl,
          downloadName: suggestName(file.name),
          originalSha256,
          scrubbedSha256,
        });
        announce(
          stripped.value.removed.length === 0
            ? "Nothing was removed — that file already carried no metadata this tool strips."
            : `${stripped.value.removed.length} metadata segments removed, ${formatBytes(stripped.value.bytesRemoved)} in total. The scrubbed file is ready to download.`,
        );
      } catch {
        setError("That file could not be read.");
        setOutcome(null);
      } finally {
        setBusy(false);
      }
    },
    [announce],
  );

  return (
    <div className="space-y-5">
      <ToolPanel
        title="Image"
        description="JPEG or PNG. The file is rewritten in this tab; nothing is uploaded, and no pixel is re-encoded."
      >
        <Label htmlFor="scrub-file">Choose an image</Label>
        <Input
          id="scrub-file"
          type="file"
          accept="image/jpeg,image/png"
          className="mt-1.5 h-11 py-2 file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void scrub(file);
          }}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Up to {formatBytes(IMAGE_GATE.maxBytes)}. Only JPEG and PNG, because those are the
          two containers whose metadata can be removed without touching the compressed image
          data. Anything else would have to be re-encoded, and a re-encoded file is not the
          same photograph.
        </p>
        {error !== null ? <FieldError>{error}</FieldError> : null}
        {busy ? <p className="mt-3 text-sm text-muted-foreground">Rewriting…</p> : null}
      </ToolPanel>

      {outcome !== null ? (
        <>
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold leading-tight">
                {outcome.result.removed.length === 0
                  ? "Nothing to remove"
                  : `${outcome.result.removed.length} segments removed`}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatBytes(outcome.originalSize)} in,{" "}
                {formatBytes(outcome.result.bytes.length)} out
                {outcome.result.bytesRemoved > 0
                  ? ` — ${formatBytes(outcome.result.bytesRemoved)} of metadata gone`
                  : ""}
                .
              </p>
            </div>
            <Button asChild size="lg">
              <a href={outcome.downloadUrl} download={outcome.downloadName}>
                <Download className="size-4" aria-hidden="true" />
                Download the scrubbed file
              </a>
            </Button>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
            <div className="leading-relaxed text-foreground-secondary">
              <p className="font-medium text-foreground">This is not redaction.</p>
              <p className="mt-1">
                Everything visible in the picture is still visible: a street sign, a reflection
                in a window, a screen, a face, a document on a desk. Sensor and encoder
                fingerprints survive too, because they are properties of the pixels. Removing
                metadata narrows one channel of disclosure and leaves the largest one
                untouched.
              </p>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ToolPanel
              title="What came out"
              description={
                outcome.result.removed.length === 0
                  ? "The file carried none of the metadata segments this tool removes. If it came through a social platform, that platform already stripped them."
                  : "Each of these is gone from the file you can download."
              }
            >
              {outcome.result.removed.length === 0 ? null : (
                <ul className="space-y-3">
                  {outcome.result.removed.map((item, index) => (
                    <li key={`${item.label}-${index}`} className="border-b border-border pb-3 last:border-b-0 last:pb-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="font-mono text-sm">{item.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(item.bytes)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        Carried {item.carries}.
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {outcome.result.kept.length > 0 ? (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="text-sm font-medium">Deliberately kept</p>
                  <ul className="mt-2 space-y-2">
                    {outcome.result.kept.map((item, index) => (
                      <li key={`${item.label}-${index}`} className="text-sm leading-relaxed text-muted-foreground">
                        <span className="font-mono text-xs text-foreground">{item.label}</span> —{" "}
                        {item.carries}.
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </ToolPanel>

            <ToolPanel
              title="Two files, two digests"
              description="The scrubbed image is a different file from the original. If the original is in your chain of custody, the published one needs its own line, and these are what connect them."
            >
              <div>
                <OutputRow
                  label="Original SHA-256"
                  value={outcome.originalSha256}
                  copyLabel="the original SHA-256"
                />
                <OutputRow
                  label="Scrubbed SHA-256"
                  value={outcome.scrubbedSha256}
                  copyLabel="the scrubbed SHA-256"
                />
                <OutputRow
                  label="Pixels"
                  value="unchanged, byte for byte"
                  copyLabel="the pixel note"
                  note="The compressed image data was copied through untouched, so the scrubbed file decodes to exactly the same picture. Only the container changed."
                />
              </div>
            </ToolPanel>
          </div>
        </>
      ) : null}
    </div>
  );
}

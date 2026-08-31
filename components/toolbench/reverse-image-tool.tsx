"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { checkFileSize, checkFileType, formatBytes, IMAGE_GATE } from "@/lib/toolbench/files";
import {
  NEGATIVE_RESULT_GUIDANCE,
  SEARCH_ENGINES,
  buildAllSearchUrls,
} from "@/lib/toolbench/reverse-image";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, ToolPanel } from "./output-row";

/**
 * The launcher.
 *
 * Deliberately does not pretend to submit a local file for you. No engine accepts a file
 * through a link, so a page that appeared to do it would have to route the image through a
 * server — and this application does not have one for that, by design. What it does instead
 * is open the four upload pages at once and preview the file locally so you can confirm you
 * are about to hand over the right picture.
 */

function EngineCard({
  name,
  operator,
  strength,
  action,
}: {
  name: string;
  operator: string;
  strength: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div>
        <p className="font-semibold leading-tight">{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{operator}</p>
      </div>
      <p className="flex-1 text-sm leading-relaxed text-foreground-secondary">{strength}</p>
      {action}
    </div>
  );
}

function ByUrlPanel() {
  const announce = useAnnounce();
  const [url, setUrl] = React.useState("");
  const built = url.trim().length === 0 ? [] : buildAllSearchUrls(url);
  const firstError = built.find((item) => item.error !== null)?.error ?? null;
  const usable = built.filter((item) => item.url !== null);

  const openAll = React.useCallback(() => {
    let opened = 0;
    for (const item of usable) {
      if (item.url === null) continue;
      const win = window.open(item.url, "_blank", "noopener,noreferrer");
      if (win !== null) opened += 1;
    }
    announce(
      opened === usable.length
        ? `Opened ${opened} search tabs.`
        : `Opened ${opened} of ${usable.length} tabs. The rest were blocked by the browser's pop-up blocker — open them one at a time instead.`,
    );
  }, [usable, announce]);

  return (
    <div className="space-y-5">
      <ToolPanel
        title="Image address"
        description="The engines fetch the image from this address themselves. Whoever hosts it will see those requests."
      >
        <Label htmlFor="reverse-url">Image URL</Label>
        <Input
          id="reverse-url"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="mt-1.5 h-11 font-mono"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={firstError !== null}
          placeholder="https://example.org/photo.jpg"
        />
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Use the address of the image file itself, not the page it sits on. If the image is
          hosted on a site the subject of your investigation controls, expect them to see the
          engines fetch it — download a copy and use the file tab instead.
        </p>
        {firstError !== null ? <FieldError>{firstError}</FieldError> : null}

        {usable.length > 0 ? (
          <Button type="button" size="lg" className="mt-4" onClick={openAll}>
            <ExternalLink className="size-4" aria-hidden="true" />
            Open all {usable.length} searches
          </Button>
        ) : null}
      </ToolPanel>

      <div className="grid gap-4 sm:grid-cols-2">
        {built.map((item) => (
          <EngineCard
            key={item.engine.id}
            name={item.engine.name}
            operator={item.engine.operator}
            strength={item.engine.strength}
            action={
              item.url === null ? (
                <p className="text-sm text-muted-foreground">{item.error}</p>
              ) : (
                <Button asChild variant="secondary" size="lg" className="w-full">
                  <a href={item.url} target="_blank" rel="noopener noreferrer nofollow">
                    Search {item.engine.name}
                    <span className="sr-only"> (opens in a new tab)</span>
                    <ExternalLink className="size-4" aria-hidden="true" />
                  </a>
                </Button>
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function ByFilePanel() {
  const announce = useAnnounce();
  const [preview, setPreview] = React.useState<{ url: string; name: string; size: number } | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const urlRef = React.useRef<string | null>(null);

  React.useEffect(
    () => () => {
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const load = React.useCallback(async (file: File) => {
    setError(null);
    const size = checkFileSize(file.size, IMAGE_GATE);
    if (!size.ok) {
      setError(size.error);
      return;
    }
    const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    const type = checkFileType(bytes, IMAGE_GATE);
    if (!type.ok) {
      setError(type.error);
      return;
    }
    if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    setPreview({ url, name: file.name, size: file.size });
  }, []);

  const openAll = React.useCallback(() => {
    let opened = 0;
    for (const engine of SEARCH_ENGINES) {
      const win = window.open(engine.uploadPage, "_blank", "noopener,noreferrer");
      if (win !== null) opened += 1;
    }
    announce(
      opened === SEARCH_ENGINES.length
        ? `Opened ${opened} upload pages. Drag the file into each one.`
        : `Opened ${opened} of ${SEARCH_ENGINES.length} pages. The rest were blocked by the browser's pop-up blocker.`,
    );
  }, [announce]);

  return (
    <div className="space-y-5">
      <ToolPanel
        title="File"
        description="Previewed here so you can confirm which picture you are about to hand over. The preview is local; the file is not uploaded by this page."
      >
        <Label htmlFor="reverse-file">Choose an image</Label>
        <Input
          id="reverse-file"
          type="file"
          accept="image/*"
          className="mt-1.5 h-11 py-2 file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void load(file);
          }}
        />
        {error !== null ? <FieldError>{error}</FieldError> : null}

        {preview !== null ? (
          <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL for the
                reader's own file. next/image would send it through the server optimiser,
                which is precisely the round trip this tool avoids. */}
            <img
              src={preview.url}
              alt={`Preview of ${preview.name}`}
              className="max-h-48 w-full rounded-md border border-border bg-muted object-contain sm:w-64"
            />
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm font-medium">{preview.name}</p>
              <p className="text-xs text-muted-foreground">{formatBytes(preview.size)}</p>
              <Button type="button" size="lg" className="mt-3" onClick={openAll}>
                <ExternalLink className="size-4" aria-hidden="true" />
                Open all {SEARCH_ENGINES.length} upload pages
              </Button>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Then drag this file into each tab. No engine accepts a file through a link, so
                this is the step that cannot be automated without a server in the middle.
              </p>
            </div>
          </div>
        ) : null}
      </ToolPanel>

      <div className="grid gap-4 sm:grid-cols-2">
        {SEARCH_ENGINES.map((engine) => (
          <EngineCard
            key={engine.id}
            name={engine.name}
            operator={engine.operator}
            strength={engine.strength}
            action={
              <Button asChild variant="secondary" size="lg" className="w-full">
                <a href={engine.uploadPage} target="_blank" rel="noopener noreferrer nofollow">
                  Open {engine.name}
                  <span className="sr-only"> (opens in a new tab)</span>
                  <ExternalLink className="size-4" aria-hidden="true" />
                </a>
              </Button>
            }
          />
        ))}
      </div>
    </div>
  );
}

export function ReverseImageTool() {
  return (
    <Announcer>
      <div className="space-y-5">
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm leading-relaxed">
          <p className="font-medium text-foreground">
            This tool discloses your image to other companies.
          </p>
          <p className="mt-1 text-foreground-secondary">
            Nothing goes to this site. The image goes to whichever engines you open, and each
            of them keeps its own record of what was searched and when. If the picture came
            from a source who would be endangered by it circulating, weigh that before you
            open anything — and consider searching a cropped, non-identifying region instead
            of the whole frame.
          </p>
        </div>

        <Tabs defaultValue="file">
          <TabsList>
            <TabsTrigger value="file">I have the file</TabsTrigger>
            <TabsTrigger value="url">I have a URL</TabsTrigger>
          </TabsList>
          <TabsContent value="file">
            <ByFilePanel />
          </TabsContent>
          <TabsContent value="url">
            <ByUrlPanel />
          </TabsContent>
        </Tabs>

        <ToolPanel title="When they all find nothing">
          <ul className="space-y-3">
            {NEGATIVE_RESULT_GUIDANCE.map((line) => (
              <li key={line} className="text-sm leading-relaxed text-foreground-secondary">
                {line}
              </li>
            ))}
          </ul>
        </ToolPanel>
      </div>
    </Announcer>
  );
}

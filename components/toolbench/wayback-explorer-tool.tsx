"use client";

import * as React from "react";
import { ArrowRight, CalendarClock, ExternalLink, GitCompare, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { CapturePair } from "@/lib/connectors/wayback";
import type { LookupOutcome } from "@/lib/toolbench/lookup";
import {
  collapseUnchanged,
  diffLines,
  snapshotViewUrl,
  type Snapshot,
  type Timeline,
} from "@/lib/toolbench/wayback";
import { cn } from "@/lib/utils";
import { Announcer, useAnnounce } from "./announcer";
import { CopyButton } from "./copy-button";
import { EmptyResult, LookupForm, LookupStatus, Provenance } from "./network-tool-shell";
import { FieldError, ToolPanel } from "./output-row";

/**
 * The Wayback capture explorer.
 *
 * Two operations, and the order between them is the technique. First the CDX index, which
 * lists every capture with a content digest — so the dates the page *changed* are readable
 * without downloading anything. Then, optionally, two captures fetched and compared as text.
 *
 * The diff renders into React text nodes. Nothing archived is ever inserted as HTML;
 * `dangerouslySetInnerHTML` is lint-banned in this repository and would be the wrong
 * instrument here regardless, since the input is an arbitrary page from an arbitrary site.
 */

export type TimelineLookup = (input: { url: string }) => Promise<LookupOutcome<Timeline>>;
export type CapturesLookup = (input: {
  url: string;
  before: string;
  after: string;
}) => Promise<LookupOutcome<CapturePair>>;

export function WaybackExplorerTool({
  lookupTimeline,
  fetchCaptures,
}: {
  lookupTimeline: TimelineLookup;
  fetchCaptures: CapturesLookup;
}) {
  return (
    <Announcer>
      <Inner lookupTimeline={lookupTimeline} fetchCaptures={fetchCaptures} />
    </Announcer>
  );
}

function Inner({
  lookupTimeline,
  fetchCaptures,
}: {
  lookupTimeline: TimelineLookup;
  fetchCaptures: CapturesLookup;
}) {
  const announce = useAnnounce();
  const [url, setUrl] = React.useState("");
  const [timeline, setTimeline] = React.useState<LookupOutcome<Timeline> | null>(null);
  const [pending, startTransition] = React.useTransition();

  const run = React.useCallback(() => {
    const value = url.trim();
    if (value.length === 0) return;
    startTransition(async () => {
      const result = await lookupTimeline({ url: value });
      setTimeline(result);
      if (result.status === "ok") {
        announce(
          `${result.data.snapshots.length} distinct versions found, spanning ${result.data.first?.capturedAt.slice(0, 10) ?? "an unknown date"} to ${result.data.last?.capturedAt.slice(0, 10) ?? "an unknown date"}.`,
        );
      }
    });
  }, [url, lookupTimeline, announce]);

  return (
    <div className="space-y-6">
      <ToolPanel
        title="Capture history"
        description="The version history of one exact URL, read from the archive's index rather than by loading each snapshot. The index carries a content digest per capture, which is how the dates a page changed can be found without downloading any of them."
      >
        <LookupForm
          id="wayback-url"
          label="URL"
          placeholder="example.com/about"
          hint="One exact URL, not a whole site. A bare host defaults to https. Fragments are dropped — they never reach a server and are never archived — and query strings are kept, because two captures of the same path can differ by one."
          value={url}
          onValueChange={setUrl}
          onSubmit={run}
          pending={pending}
          error={null}
          submitLabel="Load timeline"
        />
      </ToolPanel>

      <div aria-live="off">
        <LookupStatus outcome={timeline} />
        {timeline?.status === "ok" ? (
          <TimelineResults outcome={timeline} fetchCaptures={fetchCaptures} />
        ) : null}
      </div>
    </div>
  );
}

function TimelineResults({
  outcome,
  fetchCaptures,
}: {
  outcome: Extract<LookupOutcome<Timeline>, { status: "ok" }>;
  fetchCaptures: CapturesLookup;
}) {
  const timeline = outcome.data;

  if (timeline.snapshots.length === 0) {
    return (
      <div className="mt-6">
        <EmptyResult title="The archive holds no captures of this exact URL">
          <p>
            Read this carefully, because it is the most over-read signal in archival research.
            It does <strong className="text-foreground">not</strong> mean the page never
            existed. It means nobody crawled this exact URL. The archive normalises the host, so
            a <code className="font-mono text-xs">www.</code> prefix does not matter — but the
            path and query string are matched exactly. Try it with and without a trailing slash,
            try the parent path, and try the bare domain.
          </p>
          <p className="mt-2">
            If the page really was never captured, that is worth recording as a fact about
            crawl coverage rather than about the site. Consider archive.today, which crawls on
            request and renders dynamic pages more faithfully.
          </p>
        </EmptyResult>
        <Provenance outcome={outcome} />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <ToolPanel
        title="What the index says"
        description="These are versions, not crawls. The index query asks the archive to drop any capture whose content digest matches the one before it, so a page crawled four hundred times that changed nine times comes back as nine rows — and the redundant 391 are never transferred. Nothing here tells you how often the page was archived."
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Versions" value={String(timeline.snapshots.length)} />
          <Stat label="Distinct digests" value={String(timeline.distinctDigests)} />
          <Stat label="First" value={timeline.first?.capturedAt.slice(0, 10) ?? "—"} />
          <Stat label="Latest" value={timeline.last?.capturedAt.slice(0, 10) ?? "—"} />
        </dl>

        {timeline.truncated ? (
          <p className="mt-4 text-sm text-warning">
            <strong className="text-foreground">This history is cut short.</strong> The URL has
            more distinct versions than this tool reads in one go, and the index returns them
            oldest first — so what you are seeing starts at the beginning and stops before the
            present. The recent end is missing entirely. Query a more specific path, or use the
            archive&apos;s CDX server directly, before drawing any conclusion about recent
            changes.
          </p>
        ) : null}

        {timeline.distinctDigests < timeline.snapshots.length ? (
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            {timeline.snapshots.length - timeline.distinctDigests} of these versions repeat a
            digest seen earlier in the history — the page reverted to a previous state at least
            that many times. Collapsing only removes <em>consecutive</em> duplicates, so a
            reversion survives as its own row.
          </p>
        ) : null}

        <YearChart years={timeline.years} />

        {timeline.gaps.length > 0 ? (
          <div className="mt-5 rounded-md border border-info/40 bg-info/10 p-3 text-sm">
            <p className="font-medium text-foreground">
              {timeline.gaps.length} gap{timeline.gaps.length === 1 ? "" : "s"} of a year or more
            </p>
            <ul className="mt-2 space-y-1 text-foreground-secondary">
              {timeline.gaps.slice(0, 5).map((gap) => (
                <li key={gap.from.timestamp} className="font-mono text-xs">
                  {gap.from.capturedAt.slice(0, 10)} → {gap.to.capturedAt.slice(0, 10)} (
                  {gap.days} days)
                </li>
              ))}
            </ul>
            <p className="mt-2 leading-relaxed text-foreground-secondary">
              A gap almost always means nobody crawled the page, not that it was down. Crawl
              frequency follows a site&apos;s popularity and inbound links, so an obscure page
              is captured rarely and a prominent one many times a day. Do not read a gap as
              evidence of anything about the site.
            </p>
          </div>
        ) : null}
      </ToolPanel>

      <ChangePointList timeline={timeline} />

      <DiffPanel timeline={timeline} fetchCaptures={fetchCaptures} />

      <Provenance outcome={outcome} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Captures per year, as bars — with a table underneath carrying the same numbers.
 *
 * Not a fallback: `docs/product-brief.md` §2a requires a table equivalent for anything
 * graphical, and a bar whose height is its only encoding is unreadable to a screen reader and
 * to anyone who cannot compare lengths.
 */
function YearChart({ years }: { years: Timeline["years"] }) {
  if (years.length === 0) return null;
  const peak = Math.max(...years.map((bucket) => bucket.captures), 1);

  return (
    <div className="mt-5">
      <div className="flex items-end gap-1 overflow-x-auto pb-1" aria-hidden="true">
        {years.map((bucket) => (
          <div key={bucket.year} className="flex min-w-6 flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-sm bg-primary/70"
              style={{ height: `${Math.max(2, (bucket.captures / peak) * 72)}px` }}
              title={`${bucket.year}: ${bucket.captures} captures`}
            />
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {String(bucket.year).slice(2)}
            </span>
          </div>
        ))}
      </div>
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer py-2 text-sm text-primary underline underline-offset-4">
          Captures per year, as a table
        </summary>
        <table className="mt-2 w-full border-collapse text-sm">
          <caption className="sr-only">Captures and content changes per year</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Year
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Captures
              </th>
              <th scope="col" className="py-2 font-medium">
                Content changes
              </th>
            </tr>
          </thead>
          <tbody>
            {years.map((bucket) => (
              <tr key={bucket.year} className="border-b border-border/60 last:border-b-0">
                <th scope="row" className="py-1.5 pr-4 text-left font-mono font-normal">
                  {bucket.year}
                </th>
                <td className="py-1.5 pr-4 tabular-nums">{bucket.captures}</td>
                <td className="py-1.5 tabular-nums">{bucket.changes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** How many change points to list before collapsing. */
const VISIBLE_CHANGES = 40;

function ChangePointList({ timeline }: { timeline: Timeline }) {
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? timeline.changePoints : timeline.changePoints.slice(0, VISIBLE_CHANGES);

  if (timeline.changePoints.length === 0) {
    return (
      <ToolPanel title="When the content changed">
        <EmptyResult title="No content change is detectable between consecutive captures">
          <p>
            Every capture in this history carries the same content digest as the one before it,
            or the index carries no digest to compare. If the digests are all identical the page
            is genuinely static, which for a landing page or a redirect is unremarkable — and
            for a page you expected to change is itself a finding.
          </p>
        </EmptyResult>
      </ToolPanel>
    );
  }

  return (
    <ToolPanel
      title="When the content changed"
      description="Each row is a version whose content digest differs from the version before it, with the date the archive first saw it that way. All of this is read from the index; no snapshot has been downloaded to produce it. The date is when the change was first observed, not when it was made — the change happened somewhere between this capture and the previous one."
    >
      <ul className="divide-y divide-border">
        {shown.map((point) => (
          <li key={point.snapshot.timestamp} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
            <time dateTime={point.snapshot.capturedAt} className="font-mono text-sm">
              {point.snapshot.capturedAt.slice(0, 10)}
            </time>
            <span className="text-xs text-muted-foreground">
              changed since {point.previous.capturedAt.slice(0, 10)}
            </span>
            {point.snapshot.statusCode !== null && point.snapshot.statusCode !== 200 ? (
              <Badge variant="warning">HTTP {point.snapshot.statusCode}</Badge>
            ) : null}
            {point.snapshot.lengthBytes !== null && point.previous.lengthBytes !== null ? (
              <span className="font-mono text-xs text-muted-foreground">
                {point.previous.lengthBytes} → {point.snapshot.lengthBytes} bytes
              </span>
            ) : null}
            <ArchiveLink snapshot={point.snapshot} url={timeline.url} />
          </li>
        ))}
      </ul>
      {timeline.changePoints.length > VISIBLE_CHANGES ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 min-h-11 text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded
            ? `Show only the first ${VISIBLE_CHANGES}`
            : `Show all ${timeline.changePoints.length} changes`}
        </button>
      ) : null}
    </ToolPanel>
  );
}

function ArchiveLink({ snapshot, url }: { snapshot: Snapshot; url: string }) {
  const built = snapshotViewUrl(snapshot.timestamp, snapshot.original || url);
  if (!built.ok) return null;
  return (
    <a
      href={built.value}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-h-11 items-center gap-1 text-xs text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Open at the archive
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * The diff
 * ------------------------------------------------------------------ */

function DiffPanel({
  timeline,
  fetchCaptures,
}: {
  timeline: Timeline;
  fetchCaptures: CapturesLookup;
}) {
  const announce = useAnnounce();
  const options = timeline.snapshots;
  const [before, setBefore] = React.useState(() => options[0]?.timestamp ?? "");
  const [after, setAfter] = React.useState(
    () => options[options.length - 1]?.timestamp ?? "",
  );
  const [outcome, setOutcome] = React.useState<LookupOutcome<CapturePair> | null>(null);
  const [pending, startTransition] = React.useTransition();

  const sameCapture = before === after;

  const run = React.useCallback(() => {
    startTransition(async () => {
      const result = await fetchCaptures({ url: timeline.url, before, after });
      setOutcome(result);
      if (result.status === "ok") {
        const diff = diffLines(result.data.before.text, result.data.after.text);
        announce(`${diff.added} lines added, ${diff.removed} removed.`);
      }
    });
  }, [before, after, timeline.url, fetchCaptures, announce]);

  return (
    <ToolPanel
      title="Compare two captures"
      description="Fetches both captures in their original, unrewritten form and compares the readable text. The archive's own toolbar and link rewriting are excluded, so what you see is the page's wording rather than the archive's scaffolding."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <CaptureSelect
          id="wayback-before"
          label="Earlier capture"
          value={before}
          onChange={setBefore}
          options={options}
        />
        <CaptureSelect
          id="wayback-after"
          label="Later capture"
          value={after}
          onChange={setAfter}
          options={options}
        />
      </div>

      {sameCapture ? (
        <FieldError>Those are the same capture. Pick two different ones.</FieldError>
      ) : null}

      <Button
        type="button"
        size="lg"
        className="mt-4"
        onClick={run}
        disabled={pending || sameCapture || options.length < 2}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <GitCompare className="size-4" aria-hidden="true" />
        )}
        {pending ? "Fetching both captures…" : "Compare"}
      </Button>

      {options.length < 2 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Only one version exists in the index, so there is nothing to compare it with.
        </p>
      ) : null}

      <div className="mt-4">
        <LookupStatus outcome={outcome} />
        {outcome?.status === "ok" ? <DiffResult outcome={outcome} /> : null}
      </div>
    </ToolPanel>
  );
}

/** How many captures the select offers. A 4,000-option select is unusable in any browser. */
const MAX_OPTIONS = 400;

function CaptureSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: readonly Snapshot[];
}) {
  const shown = options.length <= MAX_OPTIONS ? options : options.slice(-MAX_OPTIONS);
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {shown.map((snapshot) => (
          <option key={snapshot.timestamp} value={snapshot.timestamp}>
            {snapshot.capturedAt.replace("T", " ").replace(".000Z", "Z")}
            {snapshot.statusCode !== null && snapshot.statusCode !== 200
              ? ` · HTTP ${snapshot.statusCode}`
              : ""}
          </option>
        ))}
      </select>
      {options.length > MAX_OPTIONS ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Showing the most recent {MAX_OPTIONS} of {options.length} captures.
        </p>
      ) : null}
    </div>
  );
}

function DiffResult({
  outcome,
}: {
  outcome: Extract<LookupOutcome<CapturePair>, { status: "ok" }>;
}) {
  const pair = outcome.data;
  const diff = React.useMemo(
    () => diffLines(pair.before.text, pair.after.text),
    [pair.before.text, pair.after.text],
  );
  const rows = React.useMemo(() => collapseUnchanged(diff, 3), [diff]);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant="destructive">{diff.removed} removed</Badge>
        <Badge variant="success">{diff.added} added</Badge>
        <span className="text-muted-foreground">{diff.unchanged} unchanged</span>
        <CopyButton
          value={rows
            .map((row) =>
              row.op === "gap"
                ? `… ${row.count} unchanged lines …`
                : `${row.op === "added" ? "+" : row.op === "removed" ? "-" : " "} ${row.text}`,
            )
            .join("\n")}
          label="the diff"
        />
      </div>

      <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="font-mono">
          {pair.before.capturedAt.slice(0, 19).replace("T", " ")}Z
        </span>
        <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
        <span className="font-mono">
          {pair.after.capturedAt.slice(0, 19).replace("T", " ")}Z
        </span>
      </p>

      {diff.approximate ? (
        <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          These captures are too large to compare line by line, so this is a coarser
          comparison: a line present in both is marked unchanged even if it moved. Treat the
          counts as approximate.
        </p>
      ) : null}

      {diff.added === 0 && diff.removed === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border p-4 text-sm leading-relaxed text-muted-foreground">
          The readable text is identical. The captures may still differ in markup, scripts,
          images or styling — this comparison deliberately looks only at words, so a redesign
          with unchanged copy shows up here as no change at all.
        </p>
      ) : (
        <pre className="mt-4 max-h-[32rem] overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-relaxed">
          <code>
            {rows.map((row, index) =>
              row.op === "gap" ? (
                <span key={index} className="block select-none py-1 text-muted-foreground">
                  {`  ⋯ ${row.count} unchanged line${row.count === 1 ? "" : "s"}`}
                </span>
              ) : (
                <span
                  key={index}
                  className={cn(
                    "block whitespace-pre-wrap",
                    row.op === "added" && "bg-success/15 text-foreground",
                    row.op === "removed" && "bg-destructive/15 text-foreground",
                    row.op === "same" && "text-muted-foreground",
                  )}
                >
                  {`${row.op === "added" ? "+" : row.op === "removed" ? "-" : " "} ${row.text}`}
                </span>
              ),
            )}
          </code>
        </pre>
      )}

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Text extracted from {pair.before.sourceBytes.toLocaleString("en-GB")} and{" "}
        {pair.after.sourceBytes.toLocaleString("en-GB")} bytes of archived HTML. Nothing
        archived is rendered on this page; both captures were reduced to plain text on our
        server before being compared.
      </p>
    </div>
  );
}

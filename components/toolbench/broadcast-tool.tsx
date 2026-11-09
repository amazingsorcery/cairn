"use client";

import * as React from "react";
import { ExternalLink, Loader2, Play, Radio, Square, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BROADCAST_ATTRIBUTION_URL,
  broadcastFilterSchema,
  countInsecure,
  DEFAULT_RESULTS,
  MAX_RESULTS,
  normaliseBroadcast,
  ORDER_LABELS,
  SEARCH_ORDERS,
  type BroadcastStation,
  type SearchOrder,
} from "@/lib/toolbench/broadcast";
import {
  describeDegraded,
  envelopeAgeSeconds,
  formatAge,
  parseEnvelope,
} from "@/lib/toolbench/connector-envelope";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, ToolPanel } from "./output-row";

/**
 * The Broadcast Finder.
 *
 * 1. Search goes through our server (so the catalogue never sees the reader's address or
 *    query); audio goes browser-to-broadcaster. No click tracking is sent to the catalogue.
 * 2. Plain-`http:` streams (~20% of the catalogue) are silently blocked as mixed content,
 *    so they get a link out instead of a play button.
 */

interface SearchState {
  readonly status: "idle" | "loading" | "done";
  readonly stations: readonly BroadcastStation[];
  readonly attribution: string | null;
  readonly fetchedAt: string | null;
  readonly connectorState: "fresh" | "stale" | "unavailable" | null;
  readonly reason: ReturnType<typeof describeDegraded> | null;
  readonly retryable: boolean;
  readonly error: string | null;
  /** Whether a search has been run at all, so "no results" is not shown before one has. */
  readonly searched: boolean;
}

const INITIAL: SearchState = {
  status: "idle",
  stations: [],
  attribution: null,
  fetchedAt: null,
  connectorState: null,
  reason: null,
  retryable: true,
  error: null,
  searched: false,
};

export function BroadcastTool() {
  return (
    <Announcer>
      <BroadcastToolInner />
    </Announcer>
  );
}

function BroadcastToolInner() {
  const announce = useAnnounce();

  const [name, setName] = React.useState("");
  const [countryCode, setCountryCode] = React.useState("");
  const [state, setState] = React.useState("");
  const [language, setLanguage] = React.useState("");
  const [tag, setTag] = React.useState("");
  const [order, setOrder] = React.useState<SearchOrder>("votes");
  const [limit, setLimit] = React.useState(String(DEFAULT_RESULTS));
  const [hideBroken, setHideBroken] = React.useState(true);

  const [result, setResult] = React.useState<SearchState>(INITIAL);
  const [nowPlaying, setNowPlaying] = React.useState<BroadcastStation | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const search = React.useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();

      const parsed = broadcastFilterSchema.safeParse({
        name,
        countryCode,
        state,
        language,
        tag,
        order,
        limit,
        hideBroken,
      });
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        setValidationError(first?.message ?? "Those filters could not be read.");
        return;
      }
      setValidationError(null);
      setResult((current) => ({ ...current, status: "loading" }));
      announce("Searching the station catalogue.");

      try {
        const response = await fetch("/toolbench/broadcast-finder/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
        const body: unknown = await response.json();
        const envelope = parseEnvelope(body);
        if (!envelope.ok) {
          setResult({ ...INITIAL, status: "done", searched: true, error: envelope.error });
          announce(envelope.error);
          return;
        }

        const payload = envelope.value.data;
        const stations =
          payload !== null && typeof payload === "object" && "stations" in payload
            ? normaliseBroadcast((payload as { stations: unknown }).stations)
            : null;

        const degraded = envelope.value.reason ? describeDegraded(envelope.value.reason) : null;

        if (stations === null || !stations.ok) {
          setResult({
            ...INITIAL,
            status: "done",
            searched: true,
            attribution: envelope.value.attribution,
            fetchedAt: envelope.value.fetchedAt,
            connectorState: envelope.value.state,
            reason: degraded,
            retryable: degraded?.retryable ?? true,
            error: degraded ? null : (stations?.ok === false ? stations.error : envelope.value.message),
          });
          announce(degraded ? `${degraded.title}. ${degraded.detail}` : "The search did not return a usable answer.");
          return;
        }

        setResult({
          status: "done",
          stations: stations.value,
          attribution: envelope.value.attribution,
          fetchedAt: envelope.value.fetchedAt,
          connectorState: envelope.value.state,
          reason: degraded,
          retryable: degraded?.retryable ?? true,
          error: null,
          searched: true,
        });

        const insecure = countInsecure(stations.value);
        announce(
          stations.value.length === 0
            ? "No stations matched those filters."
            : `${stations.value.length} stations found. ${insecure} of them stream over plain http and cannot play on this page.`,
        );
      } catch {
        const message =
          "The search could not be sent. Check your connection — this request goes to this site, not to the catalogue.";
        setResult({ ...INITIAL, status: "done", searched: true, error: message });
        announce(message);
      }
    },
    [name, countryCode, state, language, tag, order, limit, hideBroken, announce],
  );

  const playable = result.stations.filter((station) => !station.isInsecureStream);
  const blocked = result.stations.filter((station) => station.isInsecureStream);

  return (
    <div className="space-y-5">
      <ToolPanel
        title="Find stations"
        description="The search runs on this site's server so the catalogue never sees your address or what you searched for. Playback does not: your browser connects to the broadcaster directly, and nothing about the audio passes through us."
      >
        <form onSubmit={(event) => void search(event)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="bf-country">Country code</Label>
              <Input
                id="bf-country"
                value={countryCode}
                onChange={(event) => setCountryCode(event.target.value)}
                placeholder="UA"
                maxLength={2}
                autoComplete="off"
                className="mt-1.5 font-mono uppercase"
              />
              <p className="mt-1 text-xs text-muted-foreground">Two letters, ISO 3166-1.</p>
            </div>
            <div>
              <Label htmlFor="bf-state">Region or state</Label>
              <Input
                id="bf-state"
                value={state}
                onChange={(event) => setState(event.target.value)}
                placeholder="Kharkiv"
                autoComplete="off"
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Spelt as the catalogue spells it, which is not always as you would.
              </p>
            </div>
            <div>
              <Label htmlFor="bf-language">Language</Label>
              <Input
                id="bf-language"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="ukrainian"
                autoComplete="off"
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                In English, lower case: <code className="font-mono">ukrainian</code>,{" "}
                <code className="font-mono">dutch</code>.
              </p>
            </div>
            <div>
              <Label htmlFor="bf-name">Station name</Label>
              <Input
                id="bf-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="radio"
                autoComplete="off"
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-muted-foreground">Matched as a substring.</p>
            </div>
            <div>
              <Label htmlFor="bf-tag">Tag</Label>
              <Input
                id="bf-tag"
                value={tag}
                onChange={(event) => setTag(event.target.value)}
                placeholder="news"
                autoComplete="off"
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                One tag: <code className="font-mono">news</code>,{" "}
                <code className="font-mono">talk</code>, <code className="font-mono">traffic</code>.
              </p>
            </div>
            <div>
              <Label htmlFor="bf-order">Order by</Label>
              <select
                id="bf-order"
                value={order}
                onChange={(event) => setOrder(event.target.value as SearchOrder)}
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {SEARCH_ORDERS.map((value) => (
                  <option key={value} value={value}>
                    {ORDER_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="w-32">
              <Label htmlFor="bf-limit">Results</Label>
              <Input
                id="bf-limit"
                type="number"
                min={1}
                max={MAX_RESULTS}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                className="mt-1.5"
              />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={hideBroken}
                onChange={(event) => setHideBroken(event.target.checked)}
                className="size-5 rounded border-input"
              />
              <span>
                Hide stations the catalogue&apos;s own checker last found broken
                <span className="block text-xs text-muted-foreground">
                  A station that failed a check an hour ago may still be on air. For a breaking
                  story, turn this off.
                </span>
              </span>
            </label>
            <Button type="submit" size="lg" disabled={result.status === "loading"}>
              {result.status === "loading" ? (
                <>
                  <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  Searching
                </>
              ) : (
                <>
                  <Radio aria-hidden="true" />
                  Search stations
                </>
              )}
            </Button>
          </div>

          {validationError !== null ? <FieldError>{validationError}</FieldError> : null}
        </form>
      </ToolPanel>

      {result.reason !== null ? (
        <DegradedNotice
          title={result.reason.title}
          detail={result.reason.detail}
          retryable={result.reason.retryable}
        />
      ) : null}

      {result.error !== null ? <DegradedNotice title="That did not work" detail={result.error} retryable /> : null}

      {result.searched && result.reason === null && result.error === null ? (
        <Results
          stations={result.stations}
          playable={playable}
          blocked={blocked}
          attribution={result.attribution}
          fetchedAt={result.fetchedAt}
          nowPlaying={nowPlaying}
          onPlay={setNowPlaying}
        />
      ) : null}

      {nowPlaying !== null ? <Player station={nowPlaying} onStop={() => setNowPlaying(null)} /> : null}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Station data from the{" "}
        <a
          href={BROADCAST_ATTRIBUTION_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-4"
        >
          Radio Browser community catalogue
        </a>
        . The catalogue is public domain; the audio is not — it belongs to each broadcaster,
        and this page links to it rather than relaying it.
      </p>
    </div>
  );
}

function DegradedNotice({
  title,
  detail,
  retryable,
}: {
  title: string;
  detail: string;
  retryable: boolean;
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm"
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1 leading-relaxed text-foreground-secondary">{detail}</p>
        {!retryable ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Retrying will not help until that changes.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Results({
  stations,
  playable,
  blocked,
  attribution,
  fetchedAt,
  nowPlaying,
  onPlay,
}: {
  stations: readonly BroadcastStation[];
  playable: readonly BroadcastStation[];
  blocked: readonly BroadcastStation[];
  attribution: string | null;
  fetchedAt: string | null;
  nowPlaying: BroadcastStation | null;
  onPlay: (station: BroadcastStation) => void;
}) {
  if (stations.length === 0) {
    return (
      <ToolPanel title="No stations matched">
        <div className="space-y-2 text-sm leading-relaxed text-foreground-secondary">
          <p>
            The search reached the catalogue and it returned nothing for those filters. That is
            an answer, not a failure — but before you conclude a place has no radio, check the
            three things that produce a false empty:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong className="text-foreground">Language spelling.</strong> The catalogue
              stores language names in English and lower case, and contributors are
              inconsistent — try <code className="font-mono">ukrainian</code> and also the
              country code on its own.
            </li>
            <li>
              <strong className="text-foreground">Region spelling.</strong> Region is free text
              typed by whoever added the station. Drop it and filter on the country alone.
            </li>
            <li>
              <strong className="text-foreground">The broken filter.</strong> If it is on, a
              station that failed one automated check is hidden. During a power cut or an
              outage that is precisely the station you are looking for.
            </li>
          </ul>
        </div>
      </ToolPanel>
    );
  }

  return (
    <ToolPanel
      title={`${stations.length} station${stations.length === 1 ? "" : "s"}`}
      description={
        blocked.length > 0
          ? `${playable.length} can play here. ${blocked.length} stream over plain http, which a browser blocks on an https page — those are listed with a link instead of a play button, because a button that silently did nothing would be worse.`
          : "All of these stream over https and can play on this page."
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {attribution ?? "Radio Browser community catalogue"} · fetched{" "}
          {formatAge(envelopeAgeSeconds(fetchedAt))}
        </p>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Radio stations matching the search, with the country, language, stream format
              and whether the stream can play in this page.
            </caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="py-2 pr-3 font-medium">Station</th>
                <th scope="col" className="py-2 pr-3 font-medium">Place</th>
                <th scope="col" className="py-2 pr-3 font-medium">Language</th>
                <th scope="col" className="py-2 pr-3 font-medium">Stream</th>
                <th scope="col" className="py-2 pr-3 font-medium">Last checked</th>
                <th scope="col" className="py-2 font-medium">Listen</th>
              </tr>
            </thead>
            <tbody>
              {stations.map((station) => (
                <tr key={station.uuid} className="border-b border-border align-top last:border-b-0">
                  <th scope="row" className="max-w-64 py-3 pr-3 text-left font-medium">
                    {station.name}
                    {station.tags.length > 0 ? (
                      <span className="mt-1 block text-xs font-normal text-muted-foreground">
                        {station.tags.slice(0, 4).join(" · ")}
                      </span>
                    ) : null}
                  </th>
                  <td className="py-3 pr-3 text-foreground-secondary">
                    {station.country ?? "—"}
                    {station.state ? (
                      <span className="block text-xs text-muted-foreground">{station.state}</span>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3 text-foreground-secondary">{station.language ?? "—"}</td>
                  <td className="py-3 pr-3 text-foreground-secondary">
                    <span className="font-mono text-xs">
                      {station.codec ?? "?"}
                      {station.bitrateKbps ? ` ${station.bitrateKbps} kbps` : ""}
                    </span>
                    {station.isHls ? (
                      <Badge variant="muted" className="ml-1.5 align-middle">
                        HLS
                      </Badge>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3 text-xs text-muted-foreground">
                    {station.lastCheckedAt ? (
                      <time dateTime={station.lastCheckedAt}>
                        {station.lastCheckedAt.slice(0, 16).replace("T", " ")} UTC
                      </time>
                    ) : (
                      "never"
                    )}
                    {!station.lastCheckOk ? (
                      <span className="mt-0.5 block text-warning">last check failed</span>
                    ) : null}
                  </td>
                  <td className="py-3">
                    {station.isInsecureStream ? (
                      <div className="space-y-1">
                        <a
                          href={station.streamUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4"
                        >
                          Open stream
                          <ExternalLink className="size-3.5" aria-hidden="true" />
                          <span className="sr-only">
                            for {station.name}, opens outside this page
                          </span>
                        </a>
                        <span className="block text-xs text-muted-foreground">
                          http only — blocked here as mixed content
                        </span>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant={nowPlaying?.uuid === station.uuid ? "default" : "secondary"}
                        size="lg"
                        onClick={() => onPlay(station)}
                      >
                        <Play aria-hidden="true" />
                        <span className="sr-only">Play </span>
                        {nowPlaying?.uuid === station.uuid ? "Playing" : "Play"}
                        <span className="sr-only"> {station.name}</span>
                      </Button>
                    )}
                    {station.homepage ? (
                      <a
                        href={station.homepage}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-1 block text-xs text-muted-foreground underline underline-offset-4"
                      >
                        Broadcaster site
                        <span className="sr-only"> for {station.name}</span>
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </ToolPanel>
  );
}

/**
 * Single player, pointed at the broadcaster. `key` forces a new element per station, since
 * some browsers keep the old connection open when `src` changes.
 */
function Player({ station, onStop }: { station: BroadcastStation; onStop: () => void }) {
  return (
    <div className="sticky bottom-4 z-10 rounded-lg border border-border bg-card p-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{station.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            Connected directly to {hostOf(station.streamUrl)} — not through this site.
          </p>
        </div>
        <Button type="button" variant="secondary" size="lg" onClick={onStop}>
          <Square aria-hidden="true" />
          Stop
        </Button>
      </div>
      {/* A live radio stream has no caption track to offer; the station name, host and
          broadcaster link above are the text equivalent. */}
      <audio
        key={station.uuid}
        src={station.streamUrl}
        controls
        autoPlay
        preload="none"
        className="mt-3 w-full"
      />
      {station.isHls ? (
        <p className="mt-2 text-xs text-muted-foreground">
          This is an HLS stream. Safari plays it natively; most other browsers do not, and will
          show a player that never starts. Use the broadcaster&apos;s own site if it stays
          silent.
        </p>
      ) : null}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the broadcaster";
  }
}

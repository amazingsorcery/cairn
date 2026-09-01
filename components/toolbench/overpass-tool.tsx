"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { ExternalLink, Loader2, Map as MapIcon, Search, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  describeDegraded,
  envelopeAgeSeconds,
  formatAge,
  parseEnvelope,
} from "@/lib/toolbench/connector-envelope";
import {
  boundingBoxAreaKm2,
  canonicaliseQuery,
  checkBoundingBox,
  DEFAULT_RESULT_LIMIT,
  formatBoundingBox,
  MAX_BBOX_AREA_KM2,
  MAX_RESULT_LIMIT,
  normaliseOverpass,
  OSM_ATTRIBUTION,
  OSM_ATTRIBUTION_URL,
  parseBoundingBox,
  PRESET_GROUPS,
  presetsInGroup,
  queryFromPresets,
  type BoundingBox,
  type OverpassFeature,
  type OverpassResult,
} from "@/lib/toolbench/overpass";
import { Announcer, useAnnounce } from "./announcer";
import { CopyButton } from "./copy-button";
import { FieldError, ToolPanel } from "./output-row";
import type { OsmResultMapProps } from "./osm-result-map";

/**
 * The Overpass query builder.
 *
 * The generated query is shown and is editable, because a builder that hides the query
 * teaches nobody the query language and the reader will meet Overpass QL again. What is
 * submitted, though, is never the reader's bytes: `canonicaliseQuery` parses the text into a
 * structure and re-emits it, so what leaves is always a string this codebase generated. See
 * `lib/toolbench/overpass.ts` for the grammar and for why it is deliberately narrow.
 */

const OsmResultMap = dynamic<OsmResultMapProps>(() => import("./osm-result-map"), {
  ssr: false,
  loading: () => <Skeleton className="h-[26rem] w-full" />,
});

/**
 * The worked example on the page: about 47 km² over Roubaix and Tourcoing, north-east of
 * Lille. Chosen because it actually returns something — 7 water towers and 38 level crossings
 * when this was checked against the live API on 2026-09-01. A default box that returns nothing
 * would teach a reader that the tool is broken on their first click.
 */
const EXAMPLE_BOX: BoundingBox = { south: 50.62, west: 3.0, north: 50.68, east: 3.1 };

interface QueryState {
  readonly status: "idle" | "loading" | "done";
  readonly result: OverpassResult | null;
  readonly ranQuery: string | null;
  readonly bbox: BoundingBox | null;
  readonly attribution: string | null;
  readonly fetchedAt: string | null;
  readonly degraded: ReturnType<typeof describeDegraded> | null;
  readonly error: string | null;
}

const INITIAL: QueryState = {
  status: "idle",
  result: null,
  ranQuery: null,
  bbox: null,
  attribution: null,
  fetchedAt: null,
  degraded: null,
  error: null,
};

export function OverpassTool() {
  return (
    <Announcer>
      <OverpassToolInner />
    </Announcer>
  );
}

function OverpassToolInner() {
  const announce = useAnnounce();

  const [selected, setSelected] = React.useState<readonly string[]>(["water-tower"]);
  const [box, setBox] = React.useState<BoundingBox>(EXAMPLE_BOX);
  const [pasted, setPasted] = React.useState("");
  const [pasteOrder, setPasteOrder] = React.useState<"swne" | "wsen">("swne");
  const [pasteError, setPasteError] = React.useState<string | null>(null);
  const [limit, setLimit] = React.useState(DEFAULT_RESULT_LIMIT);
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<QueryState>(INITIAL);
  const [mapOpen, setMapOpen] = React.useState(false);
  const [selectedFeature, setSelectedFeature] = React.useState<string | null>(null);
  /** The map's own viewport, so "use this view" can adopt it without re-rendering the map. */
  const viewportRef = React.useRef<BoundingBox | null>(null);

  /* Regenerate whenever the inputs change and the reader has not overridden the text. */
  const [edited, setEdited] = React.useState(false);
  React.useEffect(() => {
    if (edited) return;
    const generated = queryFromPresets(selected, box, limit);
    setQuery(generated.ok ? generated.value : "");
  }, [selected, box, limit, edited]);

  const boxCheck = checkBoundingBox(box);
  const area = boundingBoxAreaKm2(box);
  const queryCheck = query.trim().length === 0 ? null : canonicaliseQuery(query);
  const canSubmit =
    boxCheck.ok && queryCheck !== null && queryCheck.ok && state.status !== "loading";

  const submit = React.useCallback(async () => {
    if (queryCheck === null || !queryCheck.ok) return;
    setState((current) => ({ ...current, status: "loading" }));
    setSelectedFeature(null);
    announce("Sending the query to the Overpass API.");

    try {
      const response = await fetch("/toolbench/overpass-builder/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: queryCheck.value }),
      });
      const body: unknown = await response.json();
      const envelope = parseEnvelope(body);
      if (!envelope.ok) {
        setState({ ...INITIAL, status: "done", error: envelope.error });
        announce(envelope.error);
        return;
      }

      const degraded = envelope.value.reason ? describeDegraded(envelope.value.reason) : null;
      const payload = envelope.value.data;
      const raw =
        payload !== null && typeof payload === "object" && "result" in payload
          ? (payload as { result: unknown }).result
          : null;
      const parsed = raw === null ? null : normaliseOverpass(raw);

      if (parsed === null || !parsed.ok) {
        setState({
          ...INITIAL,
          status: "done",
          degraded,
          attribution: envelope.value.attribution,
          error: degraded ? null : (parsed?.ok === false ? parsed.error : envelope.value.message),
        });
        announce(
          degraded ? `${degraded.title}. ${degraded.detail}` : "The query did not return a usable answer.",
        );
        return;
      }

      setState({
        status: "done",
        result: parsed.value,
        ranQuery: queryCheck.value,
        bbox: boxCheck.ok ? boxCheck.value : box,
        attribution: envelope.value.attribution,
        fetchedAt: envelope.value.fetchedAt,
        degraded,
        error: null,
      });
      announce(
        parsed.value.remark !== null
          ? `The server returned a partial answer: ${parsed.value.remark}`
          : `${parsed.value.features.length} results.`,
      );
    } catch {
      const message =
        "The query could not be sent. This request goes to this site, not to Overpass, so check your own connection first.";
      setState({ ...INITIAL, status: "done", error: message });
      announce(message);
    }
  }, [queryCheck, boxCheck, box, announce]);

  return (
    <div className="space-y-5">
      <ToolPanel
        title="1. Choose what to look for"
        description="Every preset uses nwr, so a feature mapped as a point, an outline or a relation is all found by the same query. Each one says what its tag actually covers, because a null result usually means the tagging assumption was wrong rather than that the feature is absent."
      >
        <div className="space-y-4">
          {PRESET_GROUPS.map((group) => (
            <fieldset key={group.id}>
              <legend className="text-sm font-medium">{group.label}</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {presetsInGroup(group.id).map((preset) => (
                  <label key={preset.id} className="flex min-h-11 items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(preset.id)}
                      onChange={(event) => {
                        setEdited(false);
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, preset.id]
                            : current.filter((id) => id !== preset.id),
                        );
                      }}
                      className="mt-0.5 size-5 shrink-0 rounded border-input"
                    />
                    <span>
                      {preset.label}
                      <span className="block text-xs leading-relaxed text-muted-foreground">
                        {preset.note}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </ToolPanel>

      <ToolPanel
        title="2. Bound the search"
        description={`Every query here is bounded, with no way to turn that off. The public Overpass servers are a donated community service and a country-sized query is what their usage policy asks callers not to send — so the ceiling is ${MAX_BBOX_AREA_KM2.toLocaleString("en-GB")} km², about a 160 km square.`}
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            {(
              [
                ["south", "South"],
                ["west", "West"],
                ["north", "North"],
                ["east", "East"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <Label htmlFor={`bbox-${key}`}>{label}</Label>
                <Input
                  id={`bbox-${key}`}
                  value={String(box[key])}
                  inputMode="decimal"
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    setEdited(false);
                    setBox((current) => ({ ...current, [key]: value }));
                  }}
                  className="mt-1.5 font-mono"
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Label htmlFor="bbox-paste">Or paste four numbers</Label>
              <Input
                id="bbox-paste"
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                placeholder="52.51,-1.87,52.55,-1.80"
                className="mt-1.5 font-mono"
                aria-invalid={pasteError !== null}
              />
            </div>
            <div>
              <Label htmlFor="bbox-order">Order</Label>
              <select
                id="bbox-order"
                value={pasteOrder}
                onChange={(event) => setPasteOrder(event.target.value === "wsen" ? "wsen" : "swne")}
                className="mt-1.5 flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <option value="swne">south, west, north, east (Overpass)</option>
                <option value="wsen">west, south, east, north (OSM export, GIS)</option>
              </select>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => {
                const parsed = parseBoundingBox(pasted, pasteOrder);
                if (!parsed.ok) {
                  setPasteError(parsed.error);
                  return;
                }
                setPasteError(null);
                setEdited(false);
                setBox(parsed.value);
                announce(`Bounding box set to ${formatBoundingBox(parsed.value)}.`);
              }}
            >
              Use this box
            </Button>
            {mapOpen ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => {
                  const viewport = viewportRef.current;
                  if (!viewport) return;
                  const check = checkBoundingBox(viewport);
                  if (!check.ok) {
                    setPasteError(check.error);
                    return;
                  }
                  setPasteError(null);
                  setEdited(false);
                  setBox(check.value);
                  announce(`Bounding box set to the map view: ${formatBoundingBox(check.value)}.`);
                }}
              >
                Use the current map view
              </Button>
            ) : null}
          </div>

          {pasteError !== null ? <FieldError>{pasteError}</FieldError> : null}
          {!boxCheck.ok ? <FieldError>{boxCheck.error}</FieldError> : null}

          <p className="text-xs text-muted-foreground">
            {boxCheck.ok ? (
              <>
                About{" "}
                <strong className="text-foreground">
                  {Math.round(area).toLocaleString("en-GB")} km²
                </strong>{" "}
                — {Math.round((area / MAX_BBOX_AREA_KM2) * 100)}% of the ceiling. The box is a
                spherical rectangle, so a degree square near the pole counts for less than one
                at the equator.
              </>
            ) : (
              "Fix the box before the query can be sent."
            )}
          </p>

          <div className="w-40">
            <Label htmlFor="result-limit">Maximum results</Label>
            <Input
              id="result-limit"
              type="number"
              min={1}
              max={MAX_RESULT_LIMIT}
              value={limit}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isFinite(value)) return;
                setEdited(false);
                setLimit(Math.min(Math.max(1, Math.trunc(value)), MAX_RESULT_LIMIT));
              }}
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              A geolocation candidate list should be small. If you need a thousand, the box is
              too big or the feature is too common to discriminate.
            </p>
          </div>
        </div>
      </ToolPanel>

      <ToolPanel
        title="3. The query"
        description="This is Overpass QL — the same language overpass-turbo takes. Read it, edit it, and learn it. Whatever you type is parsed back into a structure and re-emitted before it is sent, so the query that actually runs is always the one shown below the editor."
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="overpass-query">Overpass QL</Label>
            <Textarea
              id="overpass-query"
              value={query}
              onChange={(event) => {
                setEdited(true);
                setQuery(event.target.value);
              }}
              spellCheck={false}
              rows={10}
              className="mt-1.5 font-mono text-xs"
              aria-invalid={queryCheck !== null && !queryCheck.ok}
              aria-describedby={queryCheck !== null && !queryCheck.ok ? "query-error" : undefined}
            />
          </div>

          {queryCheck !== null && !queryCheck.ok ? (
            <div id="query-error">
              <FieldError>{queryCheck.error}</FieldError>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="lg" disabled={!canSubmit} onClick={() => void submit()}>
              {state.status === "loading" ? (
                <>
                  <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  Querying
                </>
              ) : (
                <>
                  <Search aria-hidden="true" />
                  Run the query
                </>
              )}
            </Button>
            {edited ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                onClick={() => {
                  setEdited(false);
                  announce("Query regenerated from the selected features and bounding box.");
                }}
              >
                Regenerate from the form
              </Button>
            ) : null}
            {queryCheck !== null && queryCheck.ok ? (
              <CopyButton value={queryCheck.value} label="Overpass query" />
            ) : null}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Exploratory work belongs in{" "}
            <a
              href="https://overpass-turbo.eu/"
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4"
            >
              overpass-turbo
              <ExternalLink className="ml-0.5 inline size-3" aria-hidden="true" />
            </a>
            , which runs the query from your own browser against your own rate-limit identity.
            It also accepts constructs this tool refuses — <code className="font-mono">area</code>,{" "}
            <code className="font-mono">around:</code>, set variables — because it does not have
            to guarantee that the query is bounded. Using it means Overpass sees your address
            instead of ours; that is a trade, not an upgrade, and it is yours to make.
          </p>
        </div>
      </ToolPanel>

      {state.degraded !== null ? (
        <Notice
          title={state.degraded.title}
          detail={state.degraded.detail}
          retryable={state.degraded.retryable}
        />
      ) : null}
      {state.error !== null ? <Notice title="That did not work" detail={state.error} retryable /> : null}

      {state.result !== null ? (
        <Results
          result={state.result}
          bbox={state.bbox ?? box}
          attribution={state.attribution}
          fetchedAt={state.fetchedAt}
          ranQuery={state.ranQuery}
          mapOpen={mapOpen}
          onOpenMap={() => {
            setMapOpen(true);
            announce("Loading the background map.");
          }}
          selectedFeature={selectedFeature}
          onSelectFeature={setSelectedFeature}
          onViewport={(viewport) => {
            viewportRef.current = viewport;
          }}
        />
      ) : null}
    </div>
  );
}

function Notice({
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
  result,
  bbox,
  attribution,
  fetchedAt,
  ranQuery,
  mapOpen,
  onOpenMap,
  selectedFeature,
  onSelectFeature,
  onViewport,
}: {
  result: OverpassResult;
  bbox: BoundingBox;
  attribution: string | null;
  fetchedAt: string | null;
  ranQuery: string | null;
  mapOpen: boolean;
  onOpenMap: () => void;
  selectedFeature: string | null;
  onSelectFeature: (id: string) => void;
  onViewport: (box: BoundingBox) => void;
}) {
  if (result.features.length === 0 && result.remark === null) {
    return (
      <ToolPanel title="No features matched">
        <div className="space-y-2 text-sm leading-relaxed text-foreground-secondary">
          <p>
            The query ran and OpenStreetMap has nothing tagged that way inside that box. The
            geolocation playbook is blunt about what that means, in descending order of
            likelihood:
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>The query is wrong.</li>
            <li>The feature is not tagged in OpenStreetMap in that region.</li>
            <li>Local tagging convention differs from the one you assumed.</li>
            <li>The feature is not there.</li>
          </ol>
          <p>
            <strong className="text-foreground">
              Test the query somewhere you know the feature exists before you conclude
              anything from a null.
            </strong>{" "}
            Most apparent nulls are bugs in the analyst, and OSM coverage varies enormously by
            country and by feature class — masts and pylons in particular are near-complete in
            parts of Europe and near-absent elsewhere.
          </p>
          {ranQuery ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                The query that ran
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                {ranQuery}
              </pre>
            </details>
          ) : null}
        </div>
      </ToolPanel>
    );
  }

  return (
    <div className="space-y-4">
      {result.remark !== null ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">
              This answer is incomplete — the server stopped early
            </p>
            <p className="mt-1 leading-relaxed text-foreground-secondary">
              Overpass answered with HTTP 200 and this remark, which means the results below
              are whatever it managed before it gave up. Treat the list as a partial sample and
              not as an answer: narrow the box, or reduce the number of feature types.
            </p>
            <p className="mt-2 font-mono text-xs text-foreground-secondary">{result.remark}</p>
          </div>
        </div>
      ) : null}

      <ToolPanel
        title={`${result.features.length} feature${result.features.length === 1 ? "" : "s"}`}
        description={
          result.elementCount > result.features.length
            ? `The server returned ${result.elementCount} elements; ${result.elementCount - result.features.length} of them carried no usable position and are not plotted. The count above is what can actually be checked against imagery.`
            : undefined
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {attribution ?? OSM_ATTRIBUTION} ·{" "}
            <a
              href={OSM_ATTRIBUTION_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4"
            >
              licence
            </a>
            {result.dataTimestamp ? (
              <>
                {" "}
                · OSM extract cut{" "}
                <time dateTime={result.dataTimestamp}>{result.dataTimestamp}</time>
              </>
            ) : null}{" "}
            · fetched {formatAge(envelopeAgeSeconds(fetchedAt))}
          </p>

          {mapOpen ? (
            <OsmResultMap
              features={result.features}
              bbox={bbox}
              selectedId={selectedFeature}
              onSelect={onSelectFeature}
              onViewportChange={onViewport}
            />
          ) : (
            <div className="flex h-[14rem] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center">
              <MapIcon className="size-6 text-muted-foreground" aria-hidden="true" />
              <p className="max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
                The map is not loaded. Opening it requests basemap tiles, which tells the tile
                host which patch of the world you are examining. The table below is complete
                without it.
              </p>
              <Button type="button" variant="secondary" size="lg" onClick={onOpenMap}>
                Show the results on a map
              </Button>
            </div>
          )}

          <FeatureTable
            features={result.features}
            selectedId={selectedFeature}
            onSelect={onSelectFeature}
          />

          {ranQuery ? (
            <details>
              <summary className="cursor-pointer text-sm font-medium">The query that ran</summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                {ranQuery}
              </pre>
            </details>
          ) : null}
        </div>
      </ToolPanel>
    </div>
  );
}

function FeatureTable({
  features,
  selectedId,
  onSelect,
}: {
  features: readonly OverpassFeature[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Every feature the query returned, with its OpenStreetMap identifier, coordinates and
          tags. This table is the equivalent of the map above and is complete without it.
        </caption>
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-2 pr-3 font-medium">Name</th>
            <th scope="col" className="py-2 pr-3 font-medium">Type</th>
            <th scope="col" className="py-2 pr-3 font-medium">Latitude, longitude</th>
            <th scope="col" className="py-2 pr-3 font-medium">Tags</th>
            <th scope="col" className="py-2 font-medium">OpenStreetMap</th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => (
            <tr
              key={feature.id}
              className={
                selectedId === feature.id
                  ? "border-b border-border bg-accent/40 align-top last:border-b-0"
                  : "border-b border-border align-top last:border-b-0"
              }
            >
              <th scope="row" className="max-w-56 py-3 pr-3 text-left font-medium">
                <button
                  type="button"
                  onClick={() => onSelect(feature.id)}
                  className="min-h-11 text-left underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {feature.label}
                  <span className="sr-only"> — highlight on the map</span>
                </button>
              </th>
              <td className="py-3 pr-3">
                <Badge variant="muted">{feature.type}</Badge>
              </td>
              <td className="py-3 pr-3 font-mono text-xs text-foreground-secondary">
                {feature.latitude.toFixed(6)}, {feature.longitude.toFixed(6)}
              </td>
              <td className="max-w-72 py-3 pr-3 text-xs text-muted-foreground">
                {Object.entries(feature.tags)
                  .slice(0, 6)
                  .map(([key, value]) => `${key}=${value}`)
                  .join(" · ")}
              </td>
              <td className="py-3">
                <a
                  href={feature.osmUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex min-h-11 items-center gap-1 text-primary underline underline-offset-4"
                >
                  {feature.id}
                  <ExternalLink className="size-3" aria-hidden="true" />
                  <span className="sr-only">, opens on openstreetmap.org</span>
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

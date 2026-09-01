"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Satellite } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  checkCoverage,
  findImageryLayer,
  GIBS_ACKNOWLEDGEMENT,
  GIBS_DOCS_URL,
  IMAGERY_LAYERS,
  metresPerPixel,
  parseIsoDate,
  REFERENCE_LAYERS,
  shiftIsoDate,
  toIsoDate,
} from "@/lib/toolbench/imagery";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, ToolPanel } from "./output-row";
import type { ImageryMapsProps, ImageryMode, ImageryView } from "./imagery-maps";

/**
 * The satellite imagery comparator: one place, two dates, two synchronised views.
 *
 * The maps and Leaflet's stylesheet are only downloaded when the reader opens them, and the
 * gate says what opening them costs before they do. See `imagery-maps.tsx`.
 */

const ImageryMaps = dynamic<ImageryMapsProps>(() => import("./imagery-maps"), {
  ssr: false,
  loading: () => <Skeleton className="h-[28rem] w-full" />,
});

/** The worked example on the page: the Nova Kakhovka reach of the Dnipro. */
const DEFAULT_VIEW: ImageryView = { latitude: 46.75, longitude: 33.37, zoom: 8 };
const DEFAULT_LAYER = "MODIS_Terra_CorrectedReflectance_TrueColor";

export function ImageryComparator() {
  return (
    <Announcer>
      <ImageryComparatorInner />
    </Announcer>
  );
}

function ImageryComparatorInner() {
  const announce = useAnnounce();
  const today = React.useMemo(() => toIsoDate(new Date()), []);

  const [opened, setOpened] = React.useState(false);
  const [mode, setMode] = React.useState<ImageryMode>("sideBySide");
  const [swipePercent, setSwipePercent] = React.useState(50);
  const [view, setView] = React.useState<ImageryView>(DEFAULT_VIEW);

  const [leftLayerId, setLeftLayerId] = React.useState(DEFAULT_LAYER);
  const [rightLayerId, setRightLayerId] = React.useState(DEFAULT_LAYER);
  const [leftDate, setLeftDate] = React.useState("2023-05-30");
  const [rightDate, setRightDate] = React.useState("2023-06-08");
  const [references, setReferences] = React.useState<readonly string[]>(["Coastlines_15m"]);

  /*
   * Latitude and longitude are typed rather than dragged. A drag-only control is unusable
   * from a keyboard, and this is the field that decides what the tool shows — the map's own
   * arrow-key panning then reports back through `onViewChange`, so the two stay in step in
   * both directions.
   */
  const [latitudeText, setLatitudeText] = React.useState(String(DEFAULT_VIEW.latitude));
  const [longitudeText, setLongitudeText] = React.useState(String(DEFAULT_VIEW.longitude));

  const leftLayer = findImageryLayer(leftLayerId);
  const rightLayer = findImageryLayer(rightLayerId);

  /*
   * Memoised because they are effect dependencies inside the map component. A fresh object
   * literal on every render would tear down and rebuild both tile layers on every keystroke
   * in the latitude field, which means re-requesting every visible tile from NASA.
   */
  const leftSpec = React.useMemo(() => ({ layerId: leftLayerId, date: leftDate }), [leftLayerId, leftDate]);
  const rightSpec = React.useMemo(
    () => ({ layerId: rightLayerId, date: rightDate }),
    [rightLayerId, rightDate],
  );

  const leftCheck = leftLayer ? checkCoverage(leftLayer, leftDate, today) : null;
  const rightCheck = rightLayer ? checkCoverage(rightLayer, rightDate, today) : null;
  const usable = leftCheck?.problem === null && rightCheck?.problem === null;

  const onViewChange = React.useCallback((next: ImageryView) => {
    setView(next);
  }, []);

  const applyTypedCentre = React.useCallback(() => {
    const latitude = Number(latitudeText);
    const longitude = Number(longitudeText);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 85) return;
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return;
    setView((current) => ({ ...current, latitude, longitude }));
    announce(`Centre moved to ${latitude}, ${longitude}.`);
  }, [latitudeText, longitudeText, announce]);

  const resolution = metresPerPixel(view.zoom, view.latitude);
  const nativeZoom = Math.min(leftLayer?.maxNativeZoom ?? 9, rightLayer?.maxNativeZoom ?? 9);
  const pastNative = view.zoom > nativeZoom;

  React.useEffect(() => {
    if (!usable) return;
    announce(
      `Comparing ${leftLayer?.label ?? ""} on ${leftDate} with ${rightLayer?.label ?? ""} on ${rightDate}.`,
    );
  }, [usable, leftLayer, rightLayer, leftDate, rightDate, announce]);

  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <DatePanel
          side="Earlier"
          idPrefix="left"
          layerId={leftLayerId}
          onLayerChange={setLeftLayerId}
          date={leftDate}
          onDateChange={setLeftDate}
          problem={leftCheck?.problem ?? null}
          today={today}
        />
        <DatePanel
          side="Later"
          idPrefix="right"
          layerId={rightLayerId}
          onLayerChange={setRightLayerId}
          date={rightDate}
          onDateChange={setRightDate}
          problem={rightCheck?.problem ?? null}
          today={today}
        />
      </div>

      <ToolPanel
        title="Where to look"
        description="Type a centre, or pan the map with the arrow keys once it is open. Coordinates are in decimal degrees, WGS 84."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Label htmlFor="imagery-lat">Latitude</Label>
            <Input
              id="imagery-lat"
              value={latitudeText}
              onChange={(event) => setLatitudeText(event.target.value)}
              inputMode="decimal"
              className="mt-1.5 font-mono"
            />
          </div>
          <div className="w-40">
            <Label htmlFor="imagery-lon">Longitude</Label>
            <Input
              id="imagery-lon"
              value={longitudeText}
              onChange={(event) => setLongitudeText(event.target.value)}
              inputMode="decimal"
              className="mt-1.5 font-mono"
            />
          </div>
          <Button type="button" variant="secondary" size="lg" onClick={applyTypedCentre}>
            Move here
          </Button>
          <div className="w-32">
            <Label htmlFor="imagery-zoom">Zoom</Label>
            <Input
              id="imagery-zoom"
              type="number"
              min={1}
              max={12}
              value={view.zoom}
              onChange={(event) => {
                const zoom = Number(event.target.value);
                if (Number.isFinite(zoom)) setView((current) => ({ ...current, zoom }));
              }}
              className="mt-1.5"
            />
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Reference overlays</legend>
          <p className="mt-1 text-xs text-muted-foreground">
            At this resolution a coastline is often the only thing that makes the image
            readable. Both overlays come from the same NASA host as the imagery.
          </p>
          <div className="mt-2 flex flex-wrap gap-4">
            {REFERENCE_LAYERS.map((reference) => (
              <label key={reference.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={references.includes(reference.id)}
                  onChange={(event) =>
                    setReferences((current) =>
                      event.target.checked
                        ? [...current, reference.id]
                        : current.filter((id) => id !== reference.id),
                    )
                  }
                  className="size-5 rounded border-input"
                />
                <span>
                  {reference.label}
                  <span className="block text-xs text-muted-foreground">
                    {reference.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </ToolPanel>

      {!opened ? (
        <div className="flex min-h-[16rem] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/40 p-6 text-center">
          <Satellite className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
            The imagery is not loaded. Your browser fetches these tiles directly from NASA,
            which is what keeps the picture out of our hands — and it means NASA sees your
            address and the exact area you are looking at. On a tool like this, the area you
            request is the thing you are investigating.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={!usable}
            onClick={() => {
              setOpened(true);
              announce("Loading satellite imagery from NASA.");
            }}
          >
            Load imagery from NASA
          </Button>
          {!usable ? (
            <p className="text-xs text-warning">
              Fix the dates above first — one of them is outside its layer&apos;s coverage.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <fieldset className="flex items-center gap-2">
              <legend className="sr-only">Comparison mode</legend>
              {(
                [
                  ["sideBySide", "Side by side"],
                  ["swipe", "Swipe"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="imagery-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    className="size-4"
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            {mode === "swipe" ? (
              <div className="flex min-w-56 flex-1 items-center gap-2">
                <Label htmlFor="imagery-swipe" className="whitespace-nowrap text-xs">
                  Divider position
                </Label>
                <input
                  id="imagery-swipe"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={swipePercent}
                  onChange={(event) => setSwipePercent(Number(event.target.value))}
                  className="h-11 w-full"
                />
                <span className="w-12 text-right font-mono text-xs text-muted-foreground">
                  {swipePercent}%
                </span>
              </div>
            ) : null}
          </div>

          <ImageryMaps
            left={leftSpec}
            right={rightSpec}
            mode={mode}
            swipePercent={swipePercent}
            view={view}
            references={references}
            onViewChange={onViewChange}
          />

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p>
              Centre {view.latitude.toFixed(4)}, {view.longitude.toFixed(4)} · zoom {view.zoom} ·
              about {Math.round(resolution)} m per screen pixel
              {pastNative ? (
                <span className="ml-1 text-warning">
                  — past this layer&apos;s deepest tiles (zoom {nativeZoom}); everything beyond
                  it is the same pixels enlarged, not more detail.
                </span>
              ) : null}
            </p>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {GIBS_ACKNOWLEDGEMENT}{" "}
            <a
              href={GIBS_DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4"
            >
              GIBS documentation
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
}

function DatePanel({
  side,
  idPrefix,
  layerId,
  onLayerChange,
  date,
  onDateChange,
  problem,
  today,
}: {
  side: string;
  idPrefix: string;
  layerId: string;
  onLayerChange: (id: string) => void;
  date: string;
  onDateChange: (date: string) => void;
  problem: string | null;
  today: string;
}) {
  const layer = findImageryLayer(layerId);

  const step = (days: number) => {
    const shifted = shiftIsoDate(date, days);
    if (shifted.ok) onDateChange(shifted.value);
  };

  return (
    <ToolPanel title={`${side} view`}>
      <div className="space-y-3">
        <div>
          <Label htmlFor={`${idPrefix}-layer`}>Imagery layer</Label>
          <select
            id={`${idPrefix}-layer`}
            value={layerId}
            onChange={(event) => onLayerChange(event.target.value)}
            className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {IMAGERY_LAYERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {layer ? (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {layer.whatItShows} {layer.overpassNote} Coverage {layer.earliest} to{" "}
              {layer.latest ?? "today"}; deepest tiles about {layer.metresPerPixel} m per pixel.
            </p>
          ) : null}
        </div>

        <div>
          <Label htmlFor={`${idPrefix}-date`}>Date (UTC)</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => step(-1)}
              aria-label={`${side} view: one day earlier`}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Input
              id={`${idPrefix}-date`}
              type="date"
              value={date}
              max={layer?.latest ?? today}
              min={layer?.earliest}
              onChange={(event) => onDateChange(event.target.value)}
              className="font-mono"
              aria-invalid={problem !== null}
              aria-describedby={problem !== null ? `${idPrefix}-date-error` : undefined}
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={() => step(1)}
              aria-label={`${side} view: one day later`}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            A satellite day, not a local one. Imagery is stamped with the UTC date of the pass.
          </p>
        </div>

        {problem !== null ? (
          <div id={`${idPrefix}-date-error`}>
            <FieldError>{problem}</FieldError>
          </div>
        ) : (
          parseIsoDate(date).ok ? null : <FieldError>Enter a date as YYYY-MM-DD.</FieldError>
        )}
      </div>
    </ToolPanel>
  );
}

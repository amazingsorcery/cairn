"use client";

import * as React from "react";
import { Sun, Moon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { parseAnyCoordinate } from "@/lib/toolbench/coordinates";
import {
  bearingDifference,
  elevationForShadowRatio,
  solarPosition,
  sunTimes,
  timesForShadowRatio,
} from "@/lib/toolbench/sun";
import { renderInZone } from "@/lib/toolbench/time";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * Sun position, and the inverse.
 *
 * The forward direction is a lookup. The inverse — which times of day could have cast the
 * shadow in this photograph — is the half that does investigative work, and it is the half
 * most tools leave out.
 */

/** Compass point for a bearing, because "213 degrees" is not a direction most readers see. */
function compassPoint(bearing: number): string {
  const points = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
  ] as const;
  return points[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16] ?? "N";
}

function useCoordinate(initial: string) {
  const [text, setText] = React.useState(initial);
  const parsed = text.trim().length === 0 ? null : parseAnyCoordinate(text);
  return { text, setText, parsed };
}

function CoordinateField({
  id,
  text,
  setText,
  error,
}: {
  id: string;
  text: string;
  setText: (value: string) => void;
  error: string | null;
}) {
  return (
    <div>
      <Label htmlFor={id}>Location</Label>
      <Input
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="mt-1.5 h-11 font-mono"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error !== null}
        placeholder="51.477928, -0.001545"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">
        Any notation the coordinate converter accepts: decimal degrees, DMS, UTM, MGRS or a
        Plus Code.
      </p>
      {error !== null ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

function ForwardPanel() {
  const announce = useAnnounce();
  const { text, setText, parsed } = useCoordinate("51.477928, -0.001545");
  const [dateTime, setDateTime] = React.useState("2026-06-21T12:00");
  const [height, setHeight] = React.useState("2");

  const when = React.useMemo(() => {
    const parsedDate = new Date(`${dateTime}:00Z`);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }, [dateTime]);

  const point = parsed !== null && parsed.ok ? parsed.value : null;
  const position = point !== null && when !== null ? solarPosition(point.latitude, point.longitude, when) : null;
  const times = point !== null && when !== null ? sunTimes(point.latitude, point.longitude, when) : null;

  React.useEffect(() => {
    if (position === null) return;
    announce(
      position.shadowRatio === null
        ? "The sun is below the horizon at that time and place."
        : `Sun elevation ${position.elevationDegrees.toFixed(1)} degrees, azimuth ${position.azimuthDegrees.toFixed(1)} degrees.`,
    );
  }, [position, announce]);

  const objectHeight = Number(height);
  const shadowLength =
    position?.shadowRatio !== null && position !== null && Number.isFinite(objectHeight)
      ? position.shadowRatio * objectHeight
      : null;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ToolPanel title="Place and time">
        <div className="space-y-4">
          <CoordinateField
            id="sun-forward-coordinate"
            text={text}
            setText={setText}
            error={parsed !== null && !parsed.ok ? parsed.error : null}
          />
          <div>
            <Label htmlFor="sun-forward-datetime">Date and time (UTC)</Label>
            <Input
              id="sun-forward-datetime"
              type="datetime-local"
              value={dateTime}
              onChange={(event) => setDateTime(event.target.value)}
              className="mt-1.5 h-11"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              UTC, not your local clock and not the location&apos;s. Convert first if your
              source gave you a local time — the timestamp tool does that.
            </p>
          </div>
          <div>
            <Label htmlFor="sun-object-height">Height of the object casting the shadow</Label>
            <Input
              id="sun-object-height"
              type="number"
              min={0}
              step="0.1"
              value={height}
              onChange={(event) => setHeight(event.target.value)}
              className="mt-1.5 h-11"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Any unit. The shadow length comes back in the same one.
            </p>
          </div>
        </div>
      </ToolPanel>

      <ToolPanel title="Where the sun is">
        {position === null || times === null ? (
          <p className="text-sm text-muted-foreground">Enter a location and a time.</p>
        ) : (
          <div>
            <OutputRow
              label="Elevation"
              value={`${position.elevationDegrees.toFixed(2)}°`}
              copyLabel="the solar elevation"
              hint={position.elevationDegrees > 0 ? "above the horizon" : "below the horizon"}
            />
            <OutputRow
              label="Azimuth"
              value={`${position.azimuthDegrees.toFixed(2)}° (${compassPoint(position.azimuthDegrees)})`}
              copyLabel="the solar azimuth"
              note="Clockwise from true north. If you are comparing this against a bearing read off a map grid, correct for grid convergence first."
            />
            <OutputRow
              label="Shadow direction"
              value={
                position.shadowBearingDegrees === null
                  ? "no shadow — the sun is down"
                  : `${position.shadowBearingDegrees.toFixed(2)}° (${compassPoint(position.shadowBearingDegrees)})`
              }
              tone={position.shadowBearingDegrees === null ? "muted" : "default"}
              copyLabel="the shadow direction"
            />
            <OutputRow
              label="Shadow length"
              value={
                position.shadowRatio === null
                  ? "no shadow — the sun is down"
                  : `${position.shadowRatio.toFixed(3)} × height${shadowLength === null ? "" : ` = ${shadowLength.toFixed(2)}`}`
              }
              tone={position.shadowRatio === null ? "muted" : "default"}
              copyLabel="the shadow length"
              note="On level ground, for a vertical object. Sloping ground, a leaning object or a camera looking along the shadow rather than across it all change what you measure in the frame."
            />
            <OutputRow
              label="Sunrise"
              value={
                times.polarDay
                  ? "the sun does not set on this date"
                  : times.sunrise === null
                    ? "the sun does not rise on this date"
                    : `${times.sunrise.toISOString().slice(11, 16)} UTC`
              }
              copyLabel="the sunrise time"
            />
            <OutputRow
              label="Solar noon"
              value={`${times.solarNoon.toISOString().slice(11, 16)} UTC`}
              copyLabel="the solar noon time"
              hint={`max elevation ${times.maximumElevationDegrees.toFixed(1)}°`}
            />
            <OutputRow
              label="Sunset"
              value={
                times.polarDay
                  ? "the sun does not set on this date"
                  : times.sunset === null
                    ? "the sun does not rise on this date"
                    : `${times.sunset.toISOString().slice(11, 16)} UTC`
              }
              copyLabel="the sunset time"
            />
          </div>
        )}
      </ToolPanel>
    </div>
  );
}

function InversePanel() {
  const announce = useAnnounce();
  const { text, setText, parsed } = useCoordinate("51.477928, -0.001545");
  const [date, setDate] = React.useState("2026-06-21");
  const [objectHeight, setObjectHeight] = React.useState("2");
  const [shadowLength, setShadowLength] = React.useState("1.4");
  const [observedBearing, setObservedBearing] = React.useState("");
  const [zone, setZone] = React.useState("UTC");

  const point = parsed !== null && parsed.ok ? parsed.value : null;
  const heightValue = Number(objectHeight);
  const lengthValue = Number(shadowLength);
  const ratio =
    Number.isFinite(heightValue) && Number.isFinite(lengthValue) && heightValue > 0
      ? lengthValue / heightValue
      : Number.NaN;

  const day = React.useMemo(() => {
    const parsedDate = new Date(`${date}T12:00:00Z`);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }, [date]);

  const result =
    point !== null && day !== null
      ? timesForShadowRatio(point.latitude, point.longitude, day, ratio)
      : null;

  React.useEffect(() => {
    if (result === null) return;
    announce(
      result.matches.length === 0
        ? (result.unreachableReason ?? "No matching time of day.")
        : `${result.matches.length} candidate times, requiring a sun elevation of ${result.targetElevationDegrees.toFixed(1)} degrees.`,
    );
  }, [result, announce]);

  const bearing = observedBearing.trim().length === 0 ? null : Number(observedBearing);
  const ranked =
    result === null
      ? []
      : [...result.matches]
          .map((match) => ({
            match,
            bearingError:
              bearing === null || !Number.isFinite(bearing)
                ? null
                : bearingDifference(match.shadowBearingDegrees, bearing),
          }))
          .sort((a, b) => (a.bearingError ?? 0) - (b.bearingError ?? 0));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ToolPanel
        title="What you measured"
        description="Measure the shadow and the object in the same units, in the image. Anything consistent works — pixels are fine."
      >
        <div className="space-y-4">
          <CoordinateField
            id="sun-inverse-coordinate"
            text={text}
            setText={setText}
            error={parsed !== null && !parsed.ok ? parsed.error : null}
          />
          <div>
            <Label htmlFor="sun-inverse-date">Date</Label>
            <Input
              id="sun-inverse-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="mt-1.5 h-11"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="sun-inverse-height">Object height</Label>
              <Input
                id="sun-inverse-height"
                type="number"
                min={0}
                step="0.1"
                value={objectHeight}
                onChange={(event) => setObjectHeight(event.target.value)}
                className="mt-1.5 h-11"
              />
            </div>
            <div>
              <Label htmlFor="sun-inverse-length">Shadow length</Label>
              <Input
                id="sun-inverse-length"
                type="number"
                min={0}
                step="0.1"
                value={shadowLength}
                onChange={(event) => setShadowLength(event.target.value)}
                className="mt-1.5 h-11"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="sun-inverse-bearing">
              Shadow direction, if you can establish north (optional)
            </Label>
            <Input
              id="sun-inverse-bearing"
              type="number"
              min={0}
              max={360}
              value={observedBearing}
              onChange={(event) => setObservedBearing(event.target.value)}
              className="mt-1.5 h-11"
              placeholder="degrees clockwise from true north"
            />
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              This is the field that resolves the ambiguity. Length alone gives two times, one
              before noon and one after; only the direction the shadow points separates them.
            </p>
          </div>
          <div>
            <Label htmlFor="sun-inverse-zone">Show the answer in</Label>
            <Input
              id="sun-inverse-zone"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
              className="mt-1.5 h-11 font-mono"
              placeholder="UTC"
            />
          </div>
        </div>
      </ToolPanel>

      <ToolPanel title="When the shadow could have been cast">
        {result === null ? (
          <p className="text-sm text-muted-foreground">Enter a location, a date and a measurement.</p>
        ) : result.matches.length === 0 ? (
          <div role="alert" className="space-y-3 text-sm leading-relaxed">
            <p className="font-medium text-foreground">No time of day fits.</p>
            <p className="text-foreground-secondary">{result.unreachableReason}</p>
            <p className="text-foreground-secondary">
              That is a finding rather than an error: it falsifies at least one of the date,
              the location and the measurement. Work out which before you use it.
            </p>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm leading-relaxed text-foreground-secondary">
              A shadow {ratio.toFixed(2)} times the height of its object needs the sun{" "}
              <strong className="font-medium text-foreground">
                {elevationForShadowRatio(ratio).toFixed(1)}°
              </strong>{" "}
              above the horizon. On this date at this place that happens{" "}
              {result.matches.length === 1 ? "once" : `${result.matches.length} times`}.
            </p>
            {ranked.map(({ match, bearingError }) => {
              const rendered = renderInZone(match.time, zone);
              return (
                <div key={match.time.toISOString()} className="border-b border-border py-3 last:border-b-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-lg">
                      {rendered.ok ? rendered.value.wallClock.slice(11, 16) : match.time.toISOString().slice(11, 16)}
                    </span>
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      {match.half}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {rendered.ok
                      ? `${rendered.value.wallClock} ${rendered.value.utcOffset}`
                      : `${match.time.toISOString()} (${rendered.error})`}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Sun azimuth</dt>
                    <dd className="font-mono">
                      {match.azimuthDegrees.toFixed(1)}° ({compassPoint(match.azimuthDegrees)})
                    </dd>
                    <dt className="text-muted-foreground">Shadow points</dt>
                    <dd className="font-mono">
                      {match.shadowBearingDegrees.toFixed(1)}° ({compassPoint(match.shadowBearingDegrees)})
                    </dd>
                    {bearingError !== null ? (
                      <>
                        <dt className="text-muted-foreground">Off your bearing by</dt>
                        <dd className={bearingError > 20 ? "font-mono text-muted-foreground" : "font-mono text-success"}>
                          {bearingError.toFixed(1)}°
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              );
            })}
            {bearing === null ? (
              <p className="mt-3 text-xs leading-relaxed text-warning">
                Without a shadow direction both candidates are equally supported. Do not pick
                the one that suits the story.
              </p>
            ) : null}
          </div>
        )}
      </ToolPanel>
    </div>
  );
}

export function SunTool() {
  return (
    <Announcer>
      <Tabs defaultValue="inverse">
        <TabsList>
          <TabsTrigger value="inverse">
            <Moon className="size-4" aria-hidden="true" />
            Time from a shadow
          </TabsTrigger>
          <TabsTrigger value="forward">
            <Sun className="size-4" aria-hidden="true" />
            Shadow from a time
          </TabsTrigger>
        </TabsList>
        <TabsContent value="inverse">
          <InversePanel />
        </TabsContent>
        <TabsContent value="forward">
          <ForwardPanel />
        </TabsContent>
      </Tabs>
    </Announcer>
  );
}

"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  COORDINATE_FORMAT_LABEL,
  parseAnyCoordinate,
  renderAllFormats,
} from "@/lib/toolbench/coordinates";
import { WHAT3WORDS_NOTE, encodePlusCode } from "@/lib/toolbench/plus-codes";
import { Announcer, useAnnounce } from "./announcer";
import { MapPreview } from "./map-preview";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * The coordinate converter.
 *
 * One input, because in practice a reader has a coordinate in whatever notation the source
 * used and does not want to tell a form which one it is. The detected notation is echoed back
 * so that a wrong guess is visible rather than silent — and the notation matters: it is what
 * decides whether "33S" was read as a latitude band or as a hemisphere, and the two are
 * 7,500 km apart.
 */

const EXAMPLES: readonly { readonly label: string; readonly value: string }[] = [
  { label: "Decimal degrees", value: "51.477928, -0.001545" },
  { label: "Degrees, minutes, seconds", value: "51°28'40.54\"N 000°00'05.56\"W" },
  { label: "UTM", value: "30U 708210 5707239" },
  { label: "MGRS", value: "30U YC 08210 07238" },
  { label: "Plus Code", value: "9C3XFXHX+59" },
];

export function CoordinateTool() {
  return (
    <Announcer>
      <CoordinateToolInner />
    </Announcer>
  );
}

function CoordinateToolInner() {
  const announce = useAnnounce();
  const [input, setInput] = React.useState("");

  const parsed = input.trim().length === 0 ? null : parseAnyCoordinate(input);
  const rendered =
    parsed !== null && parsed.ok ? renderAllFormats(parsed.value.latitude, parsed.value.longitude) : null;

  React.useEffect(() => {
    if (parsed === null) return;
    announce(
      parsed.ok
        ? `Read as ${COORDINATE_FORMAT_LABEL[parsed.value.detectedFormat]}: latitude ${parsed.value.latitude.toFixed(6)}, longitude ${parsed.value.longitude.toFixed(6)}.`
        : `Could not read that coordinate: ${parsed.error}`,
    );
  }, [parsed, announce]);

  const plusCode10 =
    parsed !== null && parsed.ok
      ? encodePlusCode(parsed.value.latitude, parsed.value.longitude, 10)
      : null;

  return (
    <div className="space-y-5">
      <ToolPanel
        title="Coordinate"
        description="Paste it in any notation. Nothing here is sent anywhere — the conversion is arithmetic done in this tab."
      >
        <Label htmlFor="coordinate-input">Coordinate</Label>
        <Input
          id="coordinate-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          className="mt-1.5 h-11 font-mono"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={parsed !== null && !parsed.ok}
          aria-describedby="coordinate-help"
          placeholder="51.477928, -0.001545"
        />
        <p id="coordinate-help" className="mt-2 text-xs text-muted-foreground">
          Decimal degrees, DMS, degrees and decimal minutes, UTM, MGRS or a full Plus Code.
        </p>
        {parsed !== null && !parsed.ok ? <FieldError>{parsed.error}</FieldError> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <Button
              key={example.label}
              type="button"
              variant="outline"
              size="sm"
              className="h-11"
              onClick={() => setInput(example.value)}
            >
              {example.label}
            </Button>
          ))}
        </div>
      </ToolPanel>

      <ToolPanel title="what3words is not here">
        <p className="text-sm leading-relaxed text-foreground-secondary">{WHAT3WORDS_NOTE}</p>
      </ToolPanel>

      {parsed !== null && parsed.ok && rendered !== null ? (
        <>
          <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm leading-relaxed">
            <p>
              Read as <strong className="font-medium">{COORDINATE_FORMAT_LABEL[parsed.value.detectedFormat]}</strong>
              {parsed.value.areaMetres > 0 ? (
                <>
                  , which names a box about{" "}
                  <strong className="font-medium">{Math.round(parsed.value.areaMetres)} m</strong> across
                  rather than a point. Everything below is the centre of that box, and is
                  therefore more precise than the coordinate you gave.
                </>
              ) : (
                ". Treated as a point."
              )}
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <ToolPanel title="Every notation">
              <div>
                <OutputRow
                  label="Decimal degrees"
                  value={rendered.decimalDegrees}
                  hint="latitude first"
                  note="Six decimal places is about 0.11 m. Publishing more digits than the source justifies is a precision claim the evidence does not support."
                />
                <OutputRow label="Degrees, minutes, seconds" value={rendered.degreesMinutesSeconds} />
                <OutputRow
                  label="Degrees and decimal minutes"
                  value={rendered.degreesDecimalMinutes}
                  hint="marine and aviation"
                />
                <OutputRow
                  label="UTM"
                  value={rendered.utm ?? rendered.utmError ?? "unavailable"}
                  tone={rendered.utm === null ? "muted" : "default"}
                  note="Meaningless without its zone and band letter, and without knowing the datum is WGS 84."
                />
                <OutputRow
                  label="MGRS"
                  value={rendered.mgrs ?? rendered.mgrsError ?? "unavailable"}
                  tone={rendered.mgrs === null ? "muted" : "default"}
                  hint="1 m precision"
                  note="Quote fewer digits when the source was coarser: four digits per axis is 10 m, two is 1 km. Precision is visible in the length, which is the point of the notation."
                />
                <OutputRow
                  label="Plus Code"
                  value={rendered.plusCode ?? rendered.plusCodeError ?? "unavailable"}
                  hint="11 digits, about 3 m"
                  tone={rendered.plusCode === null ? "muted" : "default"}
                />
                {plusCode10 !== null && plusCode10.ok ? (
                  <OutputRow
                    label="Plus Code (10 digits)"
                    value={plusCode10.value}
                    hint="about 14 m"
                    copyLabel="the ten-digit Plus Code"
                  />
                ) : null}
                <OutputRow
                  label="geo: URI"
                  value={rendered.geoUri}
                  note="RFC 5870. What a phone hands to its map application."
                />
                {rendered.gridConvergenceDegrees !== null ? (
                  <OutputRow
                    label="Grid convergence"
                    value={`${rendered.gridConvergenceDegrees.toFixed(3)}°`}
                    copyLabel="the grid convergence"
                    note="The angle between grid north and true north here. Subtract it from a bearing read off a UTM grid before comparing that bearing with a sun azimuth."
                  />
                ) : null}
              </div>
            </ToolPanel>

            <div className="space-y-5">
              <MapPreview
                latitude={parsed.value.latitude}
                longitude={parsed.value.longitude}
                label={rendered.decimalDegrees}
                accuracyMetres={parsed.value.areaMetres > 1 ? parsed.value.areaMetres / 2 : undefined}
              />

            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

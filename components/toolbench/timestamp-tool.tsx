"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TIMESTAMP_FORMATS,
  TIMESTAMP_FORMAT_INFO,
  type TimestampFormat,
  availableTimeZones,
  guessFormats,
  parseTimestamp,
  renderInZone,
  toAllFormats,
} from "@/lib/toolbench/time";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * The timestamp converter.
 *
 * Two modes, because investigators arrive with two different problems. Usually you know what
 * a value is and want it somewhere else ("this is a FILETIME, put it on my timeline"). Often
 * enough you do not: a number came out of a hex dump and nobody wrote down what it means. The
 * second mode reads the value under every epoch and shows which readings land somewhere
 * believable.
 */

const DEFAULT_ZONES = ["UTC", "Europe/London", "America/New_York"] as const;

function formatLabel(format: TimestampFormat): string {
  return TIMESTAMP_FORMAT_INFO.find((info) => info.id === format)?.label ?? format;
}

function ZoneTable({ date }: { date: Date }) {
  const zones = React.useMemo(() => availableTimeZones(), []);
  const [selected, setSelected] = React.useState<readonly string[]>(DEFAULT_ZONES);
  const [pending, setPending] = React.useState("");

  const add = React.useCallback(() => {
    const zone = pending.trim();
    if (zone.length === 0 || selected.includes(zone)) return;
    if (!zones.includes(zone)) return;
    setSelected((current) => [...current, zone]);
    setPending("");
  }, [pending, selected, zones]);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            The same instant as a wall clock in each selected time zone
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                Zone
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Wall clock
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                Offset
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {selected.map((zone) => {
              const rendered = renderInZone(date, zone);
              return (
                <tr key={zone} className="border-b border-border last:border-b-0">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {zone}
                  </th>
                  <td className="py-2 pr-3 font-mono">
                    {rendered.ok ? rendered.value.wallClock : rendered.error}
                  </td>
                  <td className="py-2 pr-3 font-mono text-muted-foreground">
                    {rendered.ok ? `${rendered.value.utcOffset} (${rendered.value.abbreviation})` : "—"}
                  </td>
                  <td className="py-2 text-right">
                    {zone === "UTC" ? null : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${zone}`}
                        onClick={() => setSelected((current) => current.filter((item) => item !== zone))}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <Label htmlFor="zone-add">Add a time zone</Label>
          <Input
            id="zone-add"
            list="zone-options"
            value={pending}
            onChange={(event) => setPending(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
            className="mt-1.5 h-11"
            placeholder="Asia/Jerusalem"
          />
          <datalist id="zone-options">
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </div>
        <Button type="button" variant="secondary" className="h-11" onClick={add}>
          <Plus className="size-4" aria-hidden="true" />
          Add
        </Button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Offsets are read from this browser&apos;s own time-zone database at the instant above,
        so a July timestamp and a January one in the same zone correctly differ. That is the
        mistake that puts half a timeline an hour out.
      </p>
    </div>
  );
}

export function TimestampTool() {
  return (
    <Announcer>
      <TimestampToolInner />
    </Announcer>
  );
}

function TimestampToolInner() {
  const announce = useAnnounce();
  const [format, setFormat] = React.useState<TimestampFormat>("unixSeconds");
  const [value, setValue] = React.useState("");

  const parsed = value.trim().length === 0 ? null : parseTimestamp(format, value);
  const guesses = React.useMemo(
    () => (value.trim().length === 0 ? [] : guessFormats(value)),
    [value],
  );

  React.useEffect(() => {
    if (parsed === null) return;
    announce(
      parsed.ok
        ? `That is ${parsed.value.date.toISOString()}.`
        : `Could not read that value: ${parsed.error}`,
    );
  }, [parsed, announce]);

  const setNow = React.useCallback(() => {
    const now = new Date();
    setFormat("iso8601");
    setValue(now.toISOString());
  }, []);

  const all = parsed !== null && parsed.ok ? toAllFormats(parsed.value.date) : null;
  const info = TIMESTAMP_FORMAT_INFO.find((item) => item.id === format);

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <ToolPanel title="Input">
          <div className="space-y-4">
            <div>
              <Label htmlFor="timestamp-format">This value is a</Label>
              <select
                id="timestamp-format"
                value={format}
                onChange={(event) => setFormat(event.target.value as TimestampFormat)}
                className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {TIMESTAMP_FORMATS.map((option) => (
                  <option key={option} value={option}>
                    {formatLabel(option)}
                  </option>
                ))}
              </select>
              {info !== undefined ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">Where you meet it:</span>{" "}
                  {info.seenIn} Resolution: {info.resolution}.
                </p>
              ) : null}
            </div>

            <div>
              <Label htmlFor="timestamp-value">Value</Label>
              <div className="mt-1.5 flex gap-2">
                <Input
                  id="timestamp-value"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  className="h-11 font-mono"
                  spellCheck={false}
                  aria-invalid={parsed !== null && !parsed.ok}
                  placeholder={format === "iso8601" ? "2026-08-31T14:05:00Z" : "133200000000000000"}
                />
                <Button type="button" variant="secondary" className="h-11" onClick={setNow}>
                  Now
                </Button>
              </div>
              {parsed !== null && !parsed.ok ? <FieldError>{parsed.error}</FieldError> : null}
              {parsed !== null && parsed.ok && parsed.value.discardedSubMillisecond !== null ? (
                <p className="mt-2 text-xs leading-relaxed text-warning">
                  {parsed.value.discardedSubMillisecond} of sub-millisecond precision is in the
                  source and cannot be carried through a JavaScript date. Everything below is
                  rounded down to the millisecond.
                </p>
              ) : null}
            </div>
          </div>
        </ToolPanel>

        <ToolPanel
          title="If you do not know what it is"
          description="The same digits read under every epoch. Readings that land between 1980 and 2100 are listed first; the rest are shown so you can see they were considered and rejected."
        >
          {guesses.length === 0 ? (
            <p className="text-sm text-muted-foreground">Type a value to see the readings.</p>
          ) : (
            <ul className="space-y-2">
              {guesses.map((guess) => (
                <li
                  key={guess.format}
                  className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => setFormat(guess.format)}
                    className="min-h-11 text-left text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {formatLabel(guess.format)}
                  </button>
                  <span
                    className={
                      guess.plausible
                        ? "font-mono text-sm"
                        : "font-mono text-sm text-muted-foreground line-through decoration-1"
                    }
                  >
                    {guess.instant.date.toISOString().replace("T", " ").replace(".000Z", "Z")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ToolPanel>
      </div>

      {all !== null && parsed !== null && parsed.ok ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <ToolPanel
            title="The same instant in every format"
            description="All of these are UTC. None of the numeric formats carries a time zone at all."
          >
            <div>
              <OutputRow label="ISO 8601 (UTC)" value={all.iso8601} />
              <OutputRow label="Unix seconds" value={all.unixSeconds} />
              <OutputRow label="Unix milliseconds" value={all.unixMilliseconds} />
              <OutputRow label="Windows FILETIME" value={all.windowsFiletime} hint="100 ns ticks" />
              <OutputRow label="WebKit / Chrome" value={all.webkitMicroseconds} hint="microseconds" />
              <OutputRow label="Mac absolute (CFAbsoluteTime)" value={all.macAbsolute} />
              <OutputRow label="HFS+" value={all.hfsPlus} />
              <OutputRow
                label="MS-DOS / FAT packed"
                value={all.dosDateTime}
                hint="2 s resolution"
                tone={all.dosDateTime.startsWith("0x") ? "default" : "muted"}
                note="Recorded with no time zone whatsoever. A ZIP made in Jakarta and one made in Reykjavik store the same wall clock with nothing to tell them apart."
              />
            </div>
          </ToolPanel>

          <ToolPanel title="As a wall clock">
            <ZoneTable date={parsed.value.date} />
          </ToolPanel>
        </div>
      ) : null}
    </div>
  );
}

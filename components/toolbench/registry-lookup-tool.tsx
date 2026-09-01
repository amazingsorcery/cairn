"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AIRCRAFT_REGISTRIES,
  decodeMmsi,
  findIcaoBlock,
  icaoToNNumber,
  nNumberToIcao,
  parseIcaoHex,
  VESSEL_REGISTRIES,
  type AuthoritativeRegistry,
} from "@/lib/toolbench/registry-lookup";
import { Announcer, useAnnounce } from "./announcer";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * Two decoders in one page: an aircraft identifier and a vessel identifier.
 *
 * Both run entirely here, against arithmetic and a table, with no request to anything. The
 * page around this component explains why that is a decision and not a shortfall.
 */

export function RegistryLookupTool() {
  return (
    <Announcer>
      <div className="space-y-5">
        <AircraftPanel />
        <VesselPanel />
      </div>
    </Announcer>
  );
}

/** Is this an ICAO hex address, or a registration? Decided by shape, and echoed back. */
function looksLikeHex(text: string): boolean {
  const cleaned = text.trim().replace(/^0x/i, "").replace(/[\s-]/g, "");
  return /^[0-9A-Fa-f]{6}$/.test(cleaned) && /[0-9A-Fa-f]/.test(cleaned);
}

function AircraftPanel() {
  const announce = useAnnounce();
  const [input, setInput] = React.useState("");
  const trimmed = input.trim();

  /*
   * `A00001` is both a valid hex address and something no registration looks like, and
   * `N612UA` is unambiguous the other way. The ambiguous case is a six-character string of
   * hex digits — `400001` — which is read as an address, because a US registration always
   * carries its N and a registration of pure digits is at most five characters.
   */
  const asHex = trimmed.length > 0 && looksLikeHex(trimmed) ? parseIcaoHex(trimmed) : null;
  const asRegistration =
    trimmed.length > 0 && !looksLikeHex(trimmed) ? nNumberToIcao(trimmed) : null;

  const address = asHex?.ok ? asHex.value : asRegistration?.ok ? asRegistration.value : null;
  const error = asHex && !asHex.ok ? asHex.error : asRegistration && !asRegistration.ok ? asRegistration.error : null;

  const block = address ? findIcaoBlock(address.value) : null;
  const registration = address ? icaoToNNumber(address) : null;

  React.useEffect(() => {
    if (trimmed.length === 0) return;
    if (address === null) {
      announce(`Could not read that identifier: ${error ?? "unknown input"}`);
      return;
    }
    announce(
      `ICAO address ${address.hex}. ${block ? `Allocated to ${block.country}.` : "Not in a block this tool has verified."} ${
        registration?.ok ? `US registration ${registration.value}.` : ""
      }`,
    );
  }, [trimmed, address, block, registration, error, announce]);

  return (
    <ToolPanel
      title="Aircraft — ICAO 24-bit address and US registration"
      description="Type either one. An ADS-B feed gives you the hex address; a registry gives you the tail number. This converts between them and tells you which state's block the address belongs to. Nothing leaves this tab."
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="aircraft-identifier">ICAO hex address or US registration</Label>
          <Input
            id="aircraft-identifier"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="4CA6C4  or  N612UA"
            spellCheck={false}
            autoComplete="off"
            className="mt-1.5 font-mono"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? "aircraft-error" : undefined}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Hex is accepted lower case, spaced, dashed or with a leading{" "}
            <code className="font-mono">0x</code>. A registration may be written with or
            without its <code className="font-mono">N</code>.
          </p>
        </div>

        {error !== null ? <div id="aircraft-error"><FieldError>{error}</FieldError></div> : null}

        {address !== null ? (
          <div className="rounded-md border border-border">
            <div className="px-4">
              <OutputRow label="ICAO 24-bit address" value={address.hex} hint="hexadecimal" />
              <OutputRow
                label="ICAO address, decimal"
                value={String(address.value)}
                hint="some feeds quote this"
              />
              <OutputRow
                label="Mode S code, octal"
                value={address.value.toString(8)}
                hint="the form the FAA registry prints"
                note="The FAA's own record shows the Mode S code in base 8 as well as base 16. Quoting the octal back at the registry is the quickest way to confirm you have the right aircraft."
              />
              <OutputRow
                label="State of registry"
                value={block ? block.country : "Not in a block this tool has verified"}
                hint={block ? `${block.start.toString(16).toUpperCase()}–${block.end.toString(16).toUpperCase()}` : undefined}
                tone={block ? "default" : "warning"}
                note={
                  block
                    ? `Registrations issued by this state begin ${block.prefixes.join(", ")}.`
                    : "This tool only lists blocks it could check against real observed aircraft, so silence here means the table does not cover this address — not that the address is unallocated."
                }
              />
              <OutputRow
                label="US registration"
                value={registration?.ok ? registration.value : "—"}
                tone={registration?.ok ? "default" : "muted"}
                note={registration?.ok ? undefined : registration?.error}
              />
            </div>
          </div>
        ) : null}

        <RegistryLinks
          heading="Where the actual record is"
          registries={AIRCRAFT_REGISTRIES}
        />
      </div>
    </ToolPanel>
  );
}

function VesselPanel() {
  const announce = useAnnounce();
  const [input, setInput] = React.useState("");
  const trimmed = input.trim();
  const result = trimmed.length === 0 ? null : decodeMmsi(trimmed);

  React.useEffect(() => {
    if (result === null) return;
    announce(
      result.ok
        ? `${result.value.mmsi} is a ${result.value.category.label}. ${result.value.mid ? `MID ${result.value.mid}, ${result.value.region ?? "region unknown"}.` : ""}`
        : `Could not read that MMSI: ${result.error}`,
    );
  }, [result, announce]);

  return (
    <ToolPanel
      title="Vessels — what an MMSI's digits say"
      description="An MMSI encodes what kind of station it belongs to and which administration issued it. This decodes that structure. It does not look the vessel up: no ship registry was found whose terms permit us to query it on your behalf, and none is faked."
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="mmsi">MMSI</Label>
          <Input
            id="mmsi"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="244123456"
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            className="mt-1.5 font-mono"
            aria-invalid={result !== null && !result.ok}
            aria-describedby={result !== null && !result.ok ? "mmsi-error" : undefined}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Nine digits. Leading zeros are part of the number and are exactly what a
            spreadsheet strips.
          </p>
        </div>

        {result !== null && !result.ok ? (
          <div id="mmsi-error"><FieldError>{result.error}</FieldError></div>
        ) : null}

        {result !== null && result.ok ? (
          <div className="rounded-md border border-border">
            <div className="px-4">
              <OutputRow
                label="Station type"
                value={result.value.category.label}
                note={result.value.category.description}
              />
              <OutputRow
                label="MID (maritime identification digits)"
                value={result.value.mid ?? "—"}
                hint={result.value.region ?? undefined}
                note={
                  result.value.mid === null
                    ? "This format carries no MID."
                    : "The MID names one administration. This tool reports only the region its first digit denotes — the administration itself has to come from the ITU's own list, linked below, because no verifiable machine-readable copy of it was found for this build."
                }
              />
            </div>
          </div>
        ) : null}

        <RegistryLinks
          heading="Where the actual record is"
          registries={VESSEL_REGISTRIES}
        />
      </div>
    </ToolPanel>
  );
}

function RegistryLinks({
  heading,
  registries,
}: {
  heading: string;
  registries: readonly AuthoritativeRegistry[];
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4">
      <h4 className="text-sm font-semibold">{heading}</h4>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        These open in a new tab and go straight to the operator. We do not fetch them for
        you, so the request is yours, from your own address.
      </p>
      <ul className="mt-3 space-y-3">
        {registries.map((registry) => (
          <li key={registry.id}>
            <a
              href={registry.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary underline underline-offset-4"
            >
              {registry.label}
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <Badge variant="muted" className="ml-2 align-middle">
              {registry.operator}
            </Badge>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{registry.note}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

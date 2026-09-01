"use client";

import * as React from "react";
import { AlertTriangle, GitBranch, Info, Mail } from "lucide-react";

import {
  SECTION_LABEL,
  isMultiOrigin,
  originChanged,
  visibilityAssessment,
  type IpIntelligence,
} from "@/lib/toolbench/ip-intel";
import type { LookupOutcome } from "@/lib/toolbench/lookup";
import { Announcer, useAnnounce } from "./announcer";
import { EmptyResult, IsoDate, LookupForm, LookupStatus, Provenance } from "./network-tool-shell";
import { OutputRow, ToolPanel } from "./output-row";

/**
 * IP intelligence from RIPEstat.
 *
 * Three things are given equal weight to the answer itself, because each is a place readers
 * routinely over-read the data:
 *
 *   - the country is the **registry's allocation record**, not a measurement of where the
 *     machine is;
 *   - a **less-specific match** means the address itself is not announced, the block
 *     containing it is;
 *   - **route visibility** is a count of RIPE RIS collectors, and a low count has several
 *     innocent explanations as well as one alarming one.
 */

export type IpLookupFn = (input: { resource: string }) => Promise<LookupOutcome<IpIntelligence>>;

export function IpIntelligenceTool({ lookup }: { lookup: IpLookupFn }) {
  return (
    <Announcer>
      <Inner lookup={lookup} />
    </Announcer>
  );
}

function Inner({ lookup }: { lookup: IpLookupFn }) {
  const announce = useAnnounce();
  const [resource, setResource] = React.useState("");
  const [outcome, setOutcome] = React.useState<LookupOutcome<IpIntelligence> | null>(null);
  const [pending, startTransition] = React.useTransition();

  const run = React.useCallback(() => {
    const value = resource.trim();
    if (value.length === 0) return;
    startTransition(async () => {
      const result = await lookup({ resource: value });
      setOutcome(result);
      if (result.status === "ok") {
        const origin = result.data.origins[0];
        announce(
          origin === undefined
            ? `No routing origin found for ${result.data.resource}.`
            : `${result.data.resource} is in ${result.data.prefix ?? "an unknown prefix"}, announced by AS${origin.asn}.`,
        );
      }
    });
  }, [resource, lookup, announce]);

  return (
    <div className="space-y-6">
      <ToolPanel
        title="Look up an address"
        description="IPv4 or IPv6. Private, loopback, link-local and documentation addresses are refused before anything is requested, with an explanation of which range they fall in."
      >
        <LookupForm
          id="ip-resource"
          label="IP address"
          placeholder="193.0.6.139"
          hint="Four decimal octets for IPv4, or the standard colon form for IPv6. Decimal, hexadecimal and short forms of an address are deliberately not accepted."
          value={resource}
          onValueChange={setResource}
          onSubmit={run}
          pending={pending}
          error={null}
          submitLabel="Look up"
        />
      </ToolPanel>

      <div aria-live="off">
        <LookupStatus outcome={outcome} />
        {outcome?.status === "ok" ? <Results outcome={outcome} /> : null}
      </div>
    </div>
  );
}

function Results({
  outcome,
}: {
  outcome: Extract<LookupOutcome<IpIntelligence>, { status: "ok" }>;
}) {
  const intel = outcome.data;
  const visibility = visibilityAssessment(intel.routing);

  return (
    <div className="mt-6 space-y-6">
      {intel.missing.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            Part of this answer is missing. The registry did not return{" "}
            {intel.missing.map((section) => SECTION_LABEL[section]).join(", ")}. The sections
            below that depend on it are blank because we do not have the data, not because
            there is none.
          </span>
        </p>
      ) : null}

      {intel.deprecatedEndpoints.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
          <span>
            RIPEstat has marked {intel.deprecatedEndpoints.join(", ")} deprecated. The answer is
            still valid today; the panel will stop working when they remove it. Worth a note to
            whoever maintains this.
          </span>
        </p>
      ) : null}

      <ToolPanel
        title="Network and origin"
        description="The prefix that covers this address, and the autonomous system announcing it in BGP."
      >
        {intel.prefix === null ? (
          <EmptyResult title="No covering prefix found">
            <p>
              The registry has no announced prefix containing this address. That usually means
              it is not routed on the public internet at all — reserved, unallocated, or
              allocated but never announced. It is a real result, and it is worth checking
              against a second source before relying on it.
            </p>
          </EmptyResult>
        ) : (
          <>
            <OutputRow
              label="Covering prefix"
              value={intel.prefix}
              hint={intel.announced === false ? "not announced" : undefined}
              note={
                intel.isLessSpecific === true ? (
                  <>
                    <strong className="text-foreground">This is a less-specific match.</strong>{" "}
                    The address itself is not separately announced; the block containing it is.
                    Everything below describes that block, which may cover many thousands of
                    unrelated hosts.
                  </>
                ) : undefined
              }
            />

            {intel.origins.length === 0 ? (
              <p className="py-3 text-sm text-muted-foreground">
                No origin AS was returned for this prefix.
              </p>
            ) : (
              intel.origins.map((origin) => (
                <OutputRow
                  key={origin.asn}
                  label={`AS${origin.asn}`}
                  value={origin.holder ?? "No holder name recorded"}
                  hint={
                    origin.routeObjects.length > 0
                      ? `route object in ${origin.routeObjects.join(", ")}`
                      : "no route object"
                  }
                  copyLabel={`AS${origin.asn}`}
                  note={
                    origin.routeObjects.length === 0 ? (
                      <>
                        No route object is registered for this announcement in an internet
                        routing registry. Extremely common and not in itself suspicious — a
                        large share of the routing table is unregistered — but it is one of the
                        conditions a hijack also satisfies.
                      </>
                    ) : undefined
                  }
                />
              ))
            )}

            {isMultiOrigin(intel) ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <GitBranch className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                <span>
                  <strong className="text-foreground">More than one AS announces this
                  prefix.</strong> Routinely legitimate — anycast, a customer announcing space
                  alongside its provider, a migration in progress — and also what a route
                  hijack looks like. It is a question to answer, not an answer.
                </span>
              </p>
            ) : null}

            {intel.ianaBlock !== null ? (
              <OutputRow
                label="IANA block"
                value={intel.ianaBlock.resource}
                hint={intel.ianaBlock.name ?? undefined}
                note={intel.ianaBlock.description}
              />
            ) : null}

            {intel.relatedPrefixes.length > 0 ? (
              <OutputRow
                label="Related prefixes"
                value={intel.relatedPrefixes.join(", ")}
                copyLabel="related prefixes"
              />
            ) : null}
          </>
        )}
      </ToolPanel>

      <ToolPanel
        title="Registry country"
        description="Where the Regional Internet Registry recorded this allocation. This is paperwork, not geography."
      >
        <OutputRow
          label="Allocation country"
          value={intel.registryCountry ?? "not recorded"}
          hint={intel.authoritativeRir === null ? undefined : `per ${intel.authoritativeRir}`}
          note={
            <>
              This is the country on the registry record for the block, and it is often the
              country of the <em>organisation that holds it</em> rather than of the machine.
              A German hosting company&apos;s address can sit in a datacentre in Singapore and
              still read DE here.{" "}
              <strong className="text-foreground">Do not put this on a map and call it a
              location.</strong>{" "}
              {intel.registryObservedAt === null ? null : (
                <>
                  Registry record observed <IsoDate value={intel.registryObservedAt} />.
                </>
              )}
            </>
          }
        />
      </ToolPanel>

      <ToolPanel
        title="BGP routing history"
        description="What RIPE's Routing Information Service has seen for this prefix, and how widely it propagates today."
      >
        {intel.routing === null ? (
          <EmptyResult title="No routing history available">
            <p>The registry did not return routing data for this prefix on this lookup.</p>
          </EmptyResult>
        ) : (
          <>
            <OutputRow
              label="First seen in BGP"
              value={intel.routing.firstSeenAt ?? "unknown"}
              hint={
                intel.routing.firstSeenOrigin === null
                  ? undefined
                  : `originated by AS${intel.routing.firstSeenOrigin}`
              }
            />
            <OutputRow
              label="Last seen in BGP"
              value={intel.routing.lastSeenAt ?? "unknown"}
              hint={
                intel.routing.lastSeenOrigin === null
                  ? undefined
                  : `originated by AS${intel.routing.lastSeenOrigin}`
              }
            />
            {originChanged(intel.routing) ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-info/40 bg-info/10 p-3 text-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                <span>
                  <strong className="text-foreground">The origin AS changed</strong> between the
                  first and last sighting — AS{intel.routing.firstSeenOrigin} then AS
                  {intel.routing.lastSeenOrigin}. Address space changes hands, and this is a
                  dated fact for a timeline. It also means any older observation you have of
                  this address may describe a completely different operator.
                </span>
              </p>
            ) : null}

            {intel.routing.peersSeeing !== null && intel.routing.totalPeers !== null ? (
              <OutputRow
                label="Route visibility"
                value={`${intel.routing.peersSeeing} of ${intel.routing.totalPeers} collectors`}
                note={visibility}
              />
            ) : null}

            {intel.routing.lessSpecifics.length > 0 ? (
              <OutputRow
                label="Less specific routes"
                value={intel.routing.lessSpecifics
                  .map((entry) => `${entry.prefix} (AS${entry.origin ?? "?"})`)
                  .join(", ")}
                copyLabel="less specific routes"
                note="Broader announcements that also cover this address. Traffic follows the most specific route, so these matter mainly when the more specific one is withdrawn."
              />
            ) : null}

            {intel.routing.moreSpecifics.length > 0 ? (
              <OutputRow
                label={`More specific routes (${intel.routing.moreSpecifics.length})`}
                value={intel.routing.moreSpecifics
                  .slice(0, 20)
                  .map((entry) => `${entry.prefix} (AS${entry.origin ?? "?"})`)
                  .join(", ")}
                copyLabel="more specific routes"
                note={
                  <>
                    Narrower announcements carved out of this block, often sub-allocations to
                    customers announced under their own AS. Worth reading: a more specific
                    route originated by an unrelated AS is either a customer, a sub-allocation,
                    or a hijack, and telling them apart needs the holder names.
                    {intel.routing.moreSpecifics.length > 20
                      ? ` ${intel.routing.moreSpecifics.length - 20} further routes not shown.`
                      : null}
                  </>
                }
              />
            ) : null}
          </>
        )}
      </ToolPanel>

      <ToolPanel
        title="Abuse contact"
        description="The address the network's own registry record nominates for abuse reports."
      >
        {intel.abuseContacts.length === 0 ? (
          <EmptyResult title="No abuse contact published">
            <p>
              The registry has no abuse contact recorded for this resource. Fall back to the
              holder&apos;s own published contact details, or to the upstream provider.
            </p>
          </EmptyResult>
        ) : (
          intel.abuseContacts.map((contact) => (
            <OutputRow key={contact} label="Abuse contact" value={contact} copyLabel="the abuse contact" />
          ))
        )}
        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Mail className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            This is the correct place to send a report, and it is not a place to send an
            investigative enquiry. Contacting a network about an address you are investigating
            tells the network — and often, quickly, the customer — that somebody is looking.
          </span>
        </p>
      </ToolPanel>

      <Provenance outcome={outcome} />
    </div>
  );
}

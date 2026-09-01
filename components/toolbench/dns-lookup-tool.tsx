"use client";

import * as React from "react";
import { CheckCircle2, CircleSlash, HelpCircle, Link2, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  RECORD_TYPE_PURPOSE,
  nameExistence,
  rcodeMeaning,
  type DnsLookup,
  type DnsRecordSet,
} from "@/lib/toolbench/dns";
import type { LookupOutcome } from "@/lib/toolbench/connector-envelope";
import { Announcer, useAnnounce } from "./announcer";
import { CopyButton } from "./copy-button";
import { LookupForm, LookupStatus, Provenance } from "./network-tool-shell";
import { ToolPanel } from "./output-row";

/**
 * DNS lookup over DNS-over-HTTPS.
 *
 * The design decision that shapes this whole component: **an empty answer is rendered, not
 * omitted.** A record type with no records gets a row saying so, and a record type the
 * resolver could not answer gets a visibly different row saying something else again. A tool
 * that shows only what it found leaves the reader to infer absence from silence, and absence
 * is exactly what gets over-read in this workflow.
 */

export type DnsLookupFn = (input: { name: string }) => Promise<LookupOutcome<DnsLookup>>;

export function DnsLookupTool({ lookup }: { lookup: DnsLookupFn }) {
  return (
    <Announcer>
      <Inner lookup={lookup} />
    </Announcer>
  );
}

function Inner({ lookup }: { lookup: DnsLookupFn }) {
  const announce = useAnnounce();
  const [name, setName] = React.useState("");
  const [outcome, setOutcome] = React.useState<LookupOutcome<DnsLookup> | null>(null);
  const [pending, startTransition] = React.useTransition();

  const run = React.useCallback(() => {
    const value = name.trim();
    if (value.length === 0) return;
    startTransition(async () => {
      const result = await lookup({ name: value });
      setOutcome(result);
      if (result.status === "ok") {
        const existence = nameExistence(result.data);
        const total = result.data.records.reduce((sum, set) => sum + set.answers.length, 0);
        announce(
          existence === "nxdomain"
            ? `${result.data.name} does not exist.`
            : `${total} records returned for ${result.data.name}.`,
        );
      }
    });
  }, [name, lookup, announce]);

  return (
    <div className="space-y-6">
      <ToolPanel
        title="Resolve a name"
        description="Six record types are queried at once: A, AAAA, MX, NS, TXT and CAA. Every one is shown, including the ones that came back empty."
      >
        <LookupForm
          id="dns-name"
          label="Domain or hostname"
          placeholder="example.com"
          hint="A bare name. Internationalised names are converted to punycode before the query, which is the form that actually goes on the wire."
          value={name}
          onValueChange={setName}
          onSubmit={run}
          pending={pending}
          error={null}
          submitLabel="Resolve"
        />
      </ToolPanel>

      <div aria-live="off">
        <LookupStatus outcome={outcome} />
        {outcome?.status === "ok" ? <Results outcome={outcome} /> : null}
      </div>
    </div>
  );
}

function Results({ outcome }: { outcome: Extract<LookupOutcome<DnsLookup>, { status: "ok" }> }) {
  const lookup = outcome.data;
  const existence = nameExistence(lookup);
  const allValues = lookup.records
    .flatMap((set) => set.answers.map((answer) => `${set.type}\t${answer.value}`))
    .join("\n");

  return (
    <div className="mt-6 space-y-6">
      <ExistenceBanner existence={existence} name={lookup.name} />

      {lookup.records.map((set) => (
        <RecordSetPanel key={set.type} set={set} />
      ))}

      {allValues.length > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Copy every record as tab-separated text, for your notes. Record the time you ran it
            alongside — DNS changes, and an undated answer is not reproducible.
          </p>
          <CopyButton value={allValues} label="all records" />
        </div>
      ) : null}

      <Provenance outcome={outcome} />
    </div>
  );
}

function ExistenceBanner({
  existence,
  name,
}: {
  existence: "exists" | "nxdomain" | "unknown";
  name: string;
}) {
  if (existence === "nxdomain") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4">
        <CircleSlash className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div className="text-sm">
          <p className="font-medium text-foreground">
            <span className="font-mono">{name}</span> does not exist
          </p>
          <p className="mt-1 leading-relaxed text-foreground-secondary">
            NXDOMAIN is authoritative: it is the zone&apos;s own servers saying there is no such
            name, which is a stronger statement than &ldquo;no records of the type you
            asked for&rdquo;. It is also a statement about <em>now</em>. A name that existed
            last year and does not today is a dated fact worth recording, not a dead end — check
            it against certificate transparency and the web archive.
          </p>
        </div>
      </div>
    );
  }

  if (existence === "unknown") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
        <HelpCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="text-sm">
          <p className="font-medium text-foreground">No query for this name could be answered</p>
          <p className="mt-1 leading-relaxed text-foreground-secondary">
            Every record type came back SERVFAIL, REFUSED or unanswered. That is a fact about
            the lookup, not about the domain: it commonly means a broken DNSSEC chain or
            unreachable authoritative servers. Do not record this as &ldquo;no
            records&rdquo;.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-success/40 bg-success/10 p-4">
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-medium text-foreground">
          <span className="font-mono">{name}</span> exists
        </p>
        <p className="mt-1 leading-relaxed text-foreground-secondary">
          At least one query returned NOERROR. Individual record types below may still be
          empty, which means the name exists and has no record of that type — a different
          finding from the name not existing.
        </p>
      </div>
    </div>
  );
}

function RecordSetPanel({ set }: { set: DnsRecordSet }) {
  const unanswered = set.rcodeStatus < 0;
  const empty = set.answers.length === 0;

  return (
    <ToolPanel title={`${set.type} records`} description={RECORD_TYPE_PURPOSE[set.type]}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant={set.rcode === "NOERROR" ? "muted" : "warning"}>
          {unanswered ? "no answer" : set.rcode}
        </Badge>
        {set.dnssecValidated ? (
          <Badge variant="success">
            <ShieldCheck className="size-3" aria-hidden="true" />
            DNSSEC validated
          </Badge>
        ) : null}
        {set.truncated ? <Badge variant="warning">truncated</Badge> : null}
      </div>

      {set.cnameChain.length > 0 ? (
        <p className="mb-3 flex items-start gap-2 rounded-md border border-info/40 bg-info/10 p-3 text-sm">
          <Link2 className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
          <span>
            Reached through an alias chain:{" "}
            <span className="break-all font-mono text-xs">{set.cnameChain.join(" → ")}</span>. The
            records below belong to the end of that chain, not to the name you asked about — so
            if the chain ends at a CDN, so does everything you can conclude from them.
          </span>
        </p>
      ) : null}

      {empty ? (
        <p className="rounded-md border border-dashed border-border p-3 text-sm leading-relaxed text-muted-foreground">
          {unanswered || set.rcode !== "NOERROR"
            ? rcodeMeaning(set.rcodeStatus)
            : `No ${set.type} records. The name exists; it simply has none of this type. That is a result, not a failure.`}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{`${set.type} records`}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Value
                </th>
                <th scope="col" className="w-24 py-2 font-medium">
                  TTL
                </th>
              </tr>
            </thead>
            <tbody>
              {set.answers.map((answer, index) => (
                <tr key={`${answer.raw}-${index}`} className="border-b border-border/60 last:border-b-0">
                  <th scope="row" className="py-2 pr-4 text-left font-normal">
                    <span className="block break-all font-mono">{answer.value}</span>
                    {answer.note !== undefined ? (
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {answer.note}
                      </span>
                    ) : null}
                    {answer.caa !== undefined && answer.caa.flags !== 0 ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Critical flag set: a CA that does not understand the{" "}
                        <code className="font-mono">{answer.caa.tag}</code> tag must refuse to
                        issue.
                      </span>
                    ) : null}
                  </th>
                  <td className="py-2 align-top font-mono text-xs tabular-nums text-muted-foreground">
                    {answer.ttlSeconds === null ? "—" : `${answer.ttlSeconds}s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {set.comment !== null && !empty ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Resolver comment: {set.comment}
        </p>
      ) : null}

      {set.type === "CAA" && empty && set.rcode === "NOERROR" ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          No CAA record means <strong className="text-foreground">any</strong> public CA may
          issue for this domain. That is the default and the most common state; it is not a
          finding on its own, but it is worth noting when the rest of the estate is tightly
          managed.
        </p>
      ) : null}
    </ToolPanel>
  );
}

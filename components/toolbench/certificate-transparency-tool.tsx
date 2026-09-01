"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ShieldQuestion } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { CertificateSummary, HostnameFinding } from "@/lib/toolbench/ct";
import { resolvableHostnames } from "@/lib/toolbench/ct";
import type { LookupOutcome } from "@/lib/toolbench/lookup";
import { Announcer, useAnnounce } from "./announcer";
import { CopyButton } from "./copy-button";
import {
  EmptyResult,
  IsoDate,
  LookupForm,
  LookupStatus,
  Provenance,
} from "./network-tool-shell";
import { ToolPanel } from "./output-row";

/**
 * Certificate transparency search.
 *
 * The output is deliberately not "a list of subdomains". It is a list of *hostnames that
 * have appeared in a publicly logged certificate*, each with the date it first did, whether
 * anything currently certificates it, and whether it is actually under the domain you asked
 * about. Those four qualifications are the difference between a finding and a number people
 * quote wrongly.
 */

export type CertificateLookup = (input: {
  domain: string;
  excludeExpired: boolean;
}) => Promise<LookupOutcome<CertificateSummary>>;

export function CertificateTransparencyTool({ lookup }: { lookup: CertificateLookup }) {
  return (
    <Announcer>
      <Inner lookup={lookup} />
    </Announcer>
  );
}

function Inner({ lookup }: { lookup: CertificateLookup }) {
  const announce = useAnnounce();
  const [domain, setDomain] = React.useState("");
  const [excludeExpired, setExcludeExpired] = React.useState(true);
  const [outcome, setOutcome] = React.useState<LookupOutcome<CertificateSummary> | null>(null);
  const [pending, startTransition] = React.useTransition();

  const run = React.useCallback(() => {
    const value = domain.trim();
    if (value.length === 0) return;
    startTransition(async () => {
      const result = await lookup({ domain: value, excludeExpired });
      setOutcome(result);
      if (result.status === "ok") {
        announce(
          `${result.data.hostnames.length} hostnames found under ${result.data.domain}, across ${result.data.certificateCount} certificates.`,
        );
      }
    });
  }, [domain, excludeExpired, lookup, announce]);

  return (
    <div className="space-y-6">
      <ToolPanel
        title="Search the logs"
        description="Enter a registered domain. The search matches the domain and everything under it — and, because crt.sh matches by text, some names that only look like it. Both are shown, separately."
      >
        <LookupForm
          id="ct-domain"
          label="Domain"
          placeholder="example.com"
          hint="A bare domain name. No scheme, no path, no port. Internationalised names are converted to punycode before the search, which is the form a certificate authority would have issued for."
          value={domain}
          onValueChange={setDomain}
          onSubmit={run}
          pending={pending}
          error={null}
          submitLabel="Search logs"
        >
          <div className="mt-4 flex min-h-11 items-center gap-3">
            <input
              id="ct-exclude-expired"
              type="checkbox"
              checked={excludeExpired}
              onChange={(event) => setExcludeExpired(event.target.checked)}
              className="size-5 rounded border-input accent-[var(--color-primary)]"
            />
            <Label htmlFor="ct-exclude-expired" className="cursor-pointer font-normal">
              Only certificates that have not yet expired
            </Label>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            On by default, and not only for speed. With expired certificates included, one
            mid-sized domain took <strong className="text-foreground">58 seconds</strong> and
            returned 1.35&nbsp;MB when this was built; the same search excluding them took four.
            Turn it off when you want the historical record — which is the whole point of a
            certificate log — and expect it to be slow, or to time out.
          </p>
        </LookupForm>
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
  outcome: Extract<LookupOutcome<CertificateSummary>, { status: "ok" }>;
}) {
  const summary = outcome.data;
  const resolvable = resolvableHostnames(summary);

  if (summary.certificateCount === 0) {
    return (
      <div className="mt-6">
        <EmptyResult title={`No logged certificates mention ${summary.domain}`}>
          <p>
            That is a real result and it has two readings. Either nothing under this domain has
            ever had a publicly trusted certificate — which is unusual for anything with a
            website, and itself worth noting — or the certificates it uses were issued by a
            private CA that does not log, which is normal for internal infrastructure and
            invisible here.
          </p>
          <p className="mt-2">
            Before concluding anything, run the same search against a domain you know is
            certificated. A source returning nothing sometimes means the source is broken.
          </p>
        </EmptyResult>
        <Provenance outcome={outcome} />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      <ToolPanel title="What the logs hold">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Hostnames" value={String(summary.hostnames.length)} />
          <Stat label="Certificates" value={String(summary.certificateCount)} />
          <Stat
            label={summary.truncated ? "Earliest in sample" : "First certificated"}
            value={summary.firstSeen === null ? "unknown" : summary.firstSeen.slice(0, 10)}
          />
          <Stat
            label="Most recent"
            value={summary.lastIssued === null ? "unknown" : summary.lastIssued.slice(0, 10)}
          />
        </dl>

        {summary.truncated ? (
          <p className="mt-4 flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong className="text-foreground">This is a sample, not an
              enumeration.</strong> The search returned more certificates than this tool reads
              in one go, and crt.sh returns the most recently logged first — so the oldest part
              of the history is missing.{" "}
              <strong className="text-foreground">Every date on this page is therefore the
              earliest within the sample, not the earliest in the log</strong>, and a
              first-seen date read from a truncated result will be too recent. Narrow the query
              to a subdomain, or query crt.sh directly, before dating anything.
            </span>
          </p>
        ) : null}

        {resolvable.length > 0 ? (
          <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              {resolvable.length} name{resolvable.length === 1 ? "" : "s"} to resolve next.
              Wildcards are excluded — they are not names a resolver can be asked about.
            </p>
            <CopyButton value={resolvable.join("\n")} label="the hostname list" />
          </div>
        ) : null}
      </ToolPanel>

      <ToolPanel
        title={`Hostnames under ${summary.domain}`}
        description="Most recently certificated first. “First seen” is the earliest not-before date across every logged certificate covering the name, which is the closest thing the log gives you to when that host was stood up."
      >
        <HostnameTable
          rows={summary.hostnames}
          caption={`Hostnames found in certificate transparency logs for ${summary.domain}`}
        />
      </ToolPanel>

      {summary.outOfScope.length > 0 ? (
        <ToolPanel
          title="Names that matched but are not under this domain"
          description="crt.sh searches by text, not by suffix, so a query for example.com also matches notexample.com and example.com.something-else.net. Most of these are noise. Occasionally one of them is the whole story."
        >
          <p className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>
              Read these for impersonation patterns: a name that puts the target domain in a
              subdomain of somebody else&apos;s domain (
              <code className="font-mono text-xs">example.com.secure-login.example</code>) is
              what a phishing host looks like in a certificate log, and it was certificated by
              whoever controls the outer domain — not by the target.
            </span>
          </p>
          <HostnameTable
            rows={summary.outOfScope}
            caption={`Names matching ${summary.domain} that are not subdomains of it`}
          />
        </ToolPanel>
      ) : null}

      <ToolPanel
        title="Issuing authorities"
        description="Which CAs signed these certificates. A single automated issuer across everything is ordinary; an unexpected one, or a cluster from a CA the rest of the estate does not use, is a thread worth pulling."
      >
        <ul className="divide-y divide-border">
          {summary.issuers.slice(0, 12).map((issuer) => (
            <li key={issuer.name} className="flex items-baseline justify-between gap-4 py-2.5">
              <span className="min-w-0">
                <span className="font-medium">{issuer.organisation ?? "Unnamed organisation"}</span>
                <span className="ml-2 break-all font-mono text-xs text-muted-foreground">
                  {issuer.name}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-sm text-muted-foreground">
                {issuer.certificateCount}
              </span>
            </li>
          ))}
        </ul>
        {summary.issuers.length > 12 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {summary.issuers.length - 12} further issuer
            {summary.issuers.length - 12 === 1 ? "" : "s"} not shown.
          </p>
        ) : null}
      </ToolPanel>

      <div className="text-sm">
        <Provenance outcome={outcome} />
        <p className="mt-3 text-xs text-muted-foreground">
          Next step:{" "}
          <Link href="/toolbench/dns-lookup" className="text-primary underline underline-offset-4">
            resolve these names
          </Link>
          . A hostname in a certificate log is not a host — many of these never resolved, or
          stopped resolving years ago, and the difference is the whole finding.
        </p>
      </div>
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

/** How many rows before the list is collapsed. A large domain returns thousands. */
const VISIBLE_ROWS = 100;

function HostnameTable({
  rows,
  caption,
}: {
  rows: readonly HostnameFinding[];
  caption: string;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const shown = expanded ? rows : rows.slice(0, VISIBLE_ROWS);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 pr-4 font-medium">
                Hostname
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                First seen
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Last issued
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Certificates
              </th>
              <th scope="col" className="py-2 font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.name} className="border-b border-border/60 last:border-b-0">
                <th scope="row" className="max-w-[24rem] break-all py-2 pr-4 text-left font-mono font-normal">
                  {row.name}
                </th>
                <td className="whitespace-nowrap py-2 pr-4">
                  <IsoDate value={row.firstSeen} />
                </td>
                <td className="whitespace-nowrap py-2 pr-4">
                  <IsoDate value={row.lastIssued} />
                </td>
                <td className="py-2 pr-4 tabular-nums">{row.certificateCount}</td>
                <td className="py-2">
                  {row.wildcard ? (
                    <Badge variant="outline" className="mr-1.5">
                      wildcard
                    </Badge>
                  ) : null}
                  {row.currentlyValid ? (
                    <Badge variant="success">current</Badge>
                  ) : (
                    <Badge variant="muted">expired</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > VISIBLE_ROWS ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-3 min-h-11 text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded
            ? `Show only the first ${VISIBLE_ROWS}`
            : `Show all ${rows.length} names (${rows.length - VISIBLE_ROWS} more)`}
        </button>
      ) : null}
    </div>
  );
}

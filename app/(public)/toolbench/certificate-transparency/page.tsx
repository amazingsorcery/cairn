import Link from "next/link";
import { notFound } from "next/navigation";

import { CertificateTransparencyTool } from "@/components/toolbench/certificate-transparency-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";
import { lookupCertificates } from "./actions";

const entry = findTool("certificate-transparency");

export const metadata = pageMetadata({
  title: "Certificate transparency search",
  description:
    "Find every hostname that has appeared in a publicly logged TLS certificate for a domain, with the date each was first certificated and which authority issued it.",
  path: "/toolbench/certificate-transparency",
});

export default function CertificateTransparencyPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            Since 2018 the major browsers have refused to trust a publicly issued TLS
            certificate unless it has been submitted to at least two{" "}
            <strong className="text-foreground">Certificate Transparency logs</strong> —
            append-only, publicly readable, cryptographically verifiable records of every
            certificate issued. The scheme exists so that a misissued certificate cannot be
            used quietly. Its side effect is the single most productive passive source in
            infrastructure investigation.
          </p>
          <p>
            Every certificate names the hostnames it covers. So the logs contain, in public,
            the name of every host anyone ever obtained a certificate for: staging servers,
            admin panels, VPN endpoints, internal-sounding names, the development environment
            somebody stood up for a fortnight in 2021. None of it was published deliberately.
            All of it is a matter of record, and it is a matter of record{" "}
            <strong className="text-foreground">for ever</strong> — removing a DNS record does
            not remove a log entry, because the log is append-only by construction.
          </p>
          <p>
            This tool queries <strong className="text-foreground">crt.sh</strong>, a free
            public index over those logs operated by Sectigo, and folds its output — one row
            per certificate — into one row per hostname, with the earliest not-before date
            across all the certificates covering it. That date is the closest thing the log
            offers to <em>when this host was stood up</em>, which is frequently how an
            operation gets dated.
          </p>
          <p>
            <strong className="text-foreground">It is completely passive.</strong> Nothing
            reaches the domain you are investigating; the query goes to a third-party index of
            data the certificate authorities published themselves. That is why step 1 of the
            playbook puts it on the passive side of the line.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">A hostname is not a host.</strong> This is the
            error to avoid, and it is extremely common. The log records that a certificate was
            issued, not that anything ever answered. Large fractions of any CT result never
            resolved, or stopped resolving years ago. Writing &ldquo;the organisation has 340
            subdomains&rdquo; on the strength of an unresolved list is wrong and checkable, so{" "}
            <Link
              href="/toolbench/dns-lookup"
              className="font-medium text-primary underline underline-offset-4"
            >
              resolve every name
            </Link>{" "}
            and record the negatives too.
          </p>
          <p>
            <strong className="text-foreground">CT is blind to anything without a public
            certificate.</strong> A host using a private or internal CA, a self-signed
            certificate, or no TLS at all leaves no trace here. Neither does anything behind a
            wildcard: a single <code className="font-mono text-sm">*.example.com</code>{" "}
            certificate covers every subdomain and names none of them, so an estate that uses
            wildcards can look almost empty. Cross-check with at least one independent passive
            source before treating this as an enumeration.
          </p>
          <p>
            <strong className="text-foreground">crt.sh matches by text, not by suffix.</strong>{" "}
            The search is a SQL <code className="font-mono text-sm">ILIKE</code>, so a query
            for <code className="font-mono text-sm">example.com</code> also returns{" "}
            <code className="font-mono text-sm">notexample.com</code> and{" "}
            <code className="font-mono text-sm">example.com.attacker-controlled.net</code>.
            This tool separates those into their own table rather than presenting them as
            subdomains — and it shows them rather than dropping them, because in an
            impersonation investigation they are the interesting rows.
          </p>
          <p>
            <strong className="text-foreground">The first-seen date is the certificate&apos;s,
            not the host&apos;s.</strong> It tells you when somebody requested a certificate,
            which usually happens as infrastructure goes up but can happen long before or long
            after. And it is the earliest date <em>in the logs we can see</em>: a certificate
            issued before CT was mandatory, or logged only to a log that has since shut down,
            may not be there.
          </p>
          <p>
            <strong className="text-foreground">Excluding expired certificates hides
            history.</strong> The tool defaults to unexpired certificates because unfiltered
            searches routinely take a minute and often fail outright. But the historical record
            is the point of a certificate log, so turn the filter off when you are dating
            infrastructure — and expect it to be slow.
          </p>
          <p>
            <strong className="text-foreground">crt.sh is one free service, and it is often
            overloaded.</strong> A run of HTTP 502s is normal rather than exceptional, and
            queries that succeed can take a minute. When that happens this page says the source
            did not answer; it does <em>not</em> say there were no results, because those are
            opposite conclusions and only one of them is ever a finding.
          </p>
          <p>
            <strong className="text-foreground">That distinction cost this tool a bug, and it
            is worth knowing why.</strong> crt.sh answers an identity search that matched
            nothing with HTTP 404 — and it also answers 404 when the query fails behind its
            front end. The two are indistinguishable from the response. An early version read a
            404 as &ldquo;no certificates&rdquo;, and during testing it reported that{" "}
            <code className="font-mono text-sm">ripe.net</code> — a domain with over four
            thousand logged certificates — had none.
          </p>
          <p>
            So this tool now treats every 404 as a failure. The consequence is that a domain
            genuinely absent from the logs will read as &ldquo;the source did not answer&rdquo;
            rather than as &ldquo;nothing found&rdquo;. That is a wrong <em>status</em>, which
            you can retry and check against crt.sh directly. The alternative was a wrong{" "}
            <em>finding</em>, which you cannot.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            Search for <code className="font-mono text-sm">ripe.net</code> with the default
            filter on. The result is a few hundred current hostnames — the tool folds several
            thousand logged certificates into one row per name — issued almost entirely by
            Let&apos;s Encrypt, which tells you the estate is automated.
          </p>
          <p>
            Read down the list for the names nobody would have chosen to publish. Among them
            are hosts named for VPN endpoints, monitoring agents and cluster nodes. None of
            those is on any website. Every one of them is in a public log because a certificate
            was issued for it.
          </p>
          <p>
            Now use the dates. Sort your notes by <em>first seen</em> and the estate tells you
            when each piece of it was built. A cluster of names first certificated within the
            same week is infrastructure stood up together — which, on a domain being
            investigated for a campaign rather than an internet registry, is exactly the shape
            you are looking for.
          </p>
          <p>
            Finally, copy the hostname list and paste each name into the DNS lookup. Expect a
            substantial fraction to return NXDOMAIN. Those are not failures of the method: a
            name that was certificated in 2019 and no longer resolves is a dated fact about
            infrastructure that was decommissioned, and it belongs on the timeline alongside
            the ones that still answer.
          </p>
        </>
      }
    >
      <CertificateTransparencyTool lookup={lookupCertificates} />
    </ToolPage>
  );
}

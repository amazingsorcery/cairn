import Link from "next/link";
import { notFound } from "next/navigation";

import { DnsLookupTool } from "@/components/toolbench/dns-lookup-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";
import { lookupDns } from "./actions";

const entry = findTool("dns-lookup");

export const metadata = pageMetadata({
  title: "DNS lookup",
  description:
    "Resolve A, AAAA, MX, NS, TXT and CAA records over DNS-over-HTTPS, with the alias chain, the DNSSEC flag, and the difference between an empty answer and a name that does not exist.",
  path: "/toolbench/dns-lookup",
});

export default function DnsLookupPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            A DNS lookup asks a resolver what a name currently points at. This tool asks
            Cloudflare&apos;s public resolver over{" "}
            <strong className="text-foreground">DNS-over-HTTPS</strong> — an ordinary HTTPS GET
            that returns JSON — and queries six record types at once, because each answers a
            different question and the interesting findings are usually in the disagreements
            between them.
          </p>
          <p>
            <strong className="text-foreground">A</strong> and{" "}
            <strong className="text-foreground">AAAA</strong> give the addresses a browser
            would connect to.{" "}
            <strong className="text-foreground">NS</strong> names the authoritative servers,
            and a change of nameserver is one of the most useful dated facts in an
            infrastructure timeline — it usually marks a change of operator.{" "}
            <strong className="text-foreground">MX</strong> shows where mail goes, which is
            frequently a different provider from the web hosting and therefore a second
            organisation to look at. <strong className="text-foreground">TXT</strong> carries
            SPF and DMARC policy, DKIM keys and — the useful part — verification tokens, each
            of which proves somebody demonstrated control of this domain at a named service.{" "}
            <strong className="text-foreground">CAA</strong> lists the certificate authorities
            permitted to issue for it.
          </p>
          <p>
            Two things are surfaced that a bare <code className="font-mono text-sm">dig</code>{" "}
            makes you notice for yourself. The{" "}
            <strong className="text-foreground">alias chain</strong>: when a name is a CNAME to
            something else, the addresses returned belong to the end of the chain, so if that
            end is a CDN then the IP tells you about the CDN and not about the target. And the{" "}
            <strong className="text-foreground">response code</strong>, rendered as a sentence,
            because the distinction between &ldquo;this name does not exist&rdquo; and
            &ldquo;the resolver could not find out&rdquo; is the one this tool exists to make
            unmissable.
          </p>
          <p>
            <strong className="text-foreground">This is an active-adjacent step, and worth a
            moment&apos;s thought.</strong> The query goes to a public recursive resolver, not
            to the target — but if the answer is not already cached, that resolver will query
            the target&apos;s authoritative nameservers, and those are frequently operated by
            the target. It is far less exposing than loading their website, and it is not
            nothing.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">An empty answer and a failed lookup look the
            same if you let them.</strong> This page never lets them. NOERROR with no records
            means the name exists and has none of that type. NXDOMAIN means the name does not
            exist at all. SERVFAIL means the resolver could not complete the lookup — commonly
            a broken DNSSEC chain or unreachable authoritative servers — and it is a fact about
            the lookup, not the domain. Recording a SERVFAIL as &ldquo;no records&rdquo; is how
            a bug becomes a published claim.
          </p>
          <p>
            <strong className="text-foreground">One resolver is one vantage point.</strong>{" "}
            Answers vary by geography and by resolver: content-delivery networks return
            different addresses to different parts of the world, and split-horizon DNS returns
            different answers inside a network from outside it. What you see here is what
            Cloudflare returns to our server. If where the answer came from matters to your
            finding, check a second resolver from a second location.
          </p>
          <p>
            <strong className="text-foreground">You are seeing a cache, and the TTL is
            already ticking.</strong> The TTL shown is the resolver&apos;s remaining time, not
            the zone&apos;s configured value, so it is smaller than what the operator set. A
            change made minutes ago may not have reached this resolver, and a record deleted
            minutes ago may still be served.
          </p>
          <p>
            <strong className="text-foreground">DNS is a statement about now, and only
            now.</strong> There is no history here. If you need to know what a domain resolved
            to last year you need a passive-DNS provider, which this tool is not. Timestamp
            every answer you record; an undated DNS observation is not reproducible and can be
            actively misleading three weeks later.
          </p>
          <p>
            <strong className="text-foreground">DNSSEC validation is about integrity, not
            honesty.</strong> The DNSSEC badge means the resolver verified the answer was not
            tampered with in transit. It says nothing about whether the contents are true, who
            operates the domain, or whether it is malicious.
          </p>
          <p>
            <strong className="text-foreground">A verification token identifies a service, not
            a person.</strong> A <code className="font-mono text-sm">google-site-verification</code>{" "}
            record tells you somebody proved control of this domain to Google at some point. It
            does not tell you who, or when, and the record often long outlives the account that
            created it.
          </p>
          <p>
            <strong className="text-foreground">There is no WHOIS here, deliberately.</strong>{" "}
            Registration data is the natural companion to this lookup and it is not included:
            the port-43 and RDAP services that publish it are operated by hundreds of separate
            registries under terms that differ registry by registry, most gTLD records are
            redacted under GDPR anyway, and the answers contain personal data we would then be
            processing. Rather than ship a fifth panel whose legal basis we could not state
            per-registry, the tool does four record types honestly. The{" "}
            <Link
              href="/directory"
              className="font-medium text-primary underline underline-offset-4"
            >
              directory
            </Link>{" "}
            catalogues WHOIS and historical-WHOIS services, and step 2 of the playbook covers
            how to read them — including the warning that a name in a WHOIS record is an
            unverified self-assertion, never an identification.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            Resolve <code className="font-mono text-sm">www.bbc.co.uk</code>. The A record
            panel returns four addresses — and above them, an alias chain:{" "}
            <code className="font-mono text-sm">www.bbc.co.uk.pri.bbc.co.uk</code> then{" "}
            <code className="font-mono text-sm">bbc.map.fastly.net</code>.
          </p>
          <p>
            That chain changes what the addresses mean. They are Fastly&apos;s, not the
            BBC&apos;s. Looking one up in the{" "}
            <Link
              href="/toolbench/ip-intelligence"
              className="font-medium text-primary underline underline-offset-4"
            >
              IP intelligence tool
            </Link>{" "}
            will tell you about Fastly&apos;s network and nothing whatsoever about where the
            BBC hosts anything. An investigator who skipped the chain and wrote &ldquo;the site
            is hosted on AS54113&rdquo; would have written something true about the CDN and
            false about the target. Note the CDN explicitly and stop drawing hosting
            conclusions from the address.
          </p>
          <p>
            Now resolve <code className="font-mono text-sm">ripe.net</code> and read the TXT
            panel. Alongside the SPF policy sit several verification tokens. Each names a
            service the organisation uses — a document-signing platform, a search console, a
            collaboration suite — and that list of services is itself a small finding: it tells
            you which vendors to look at, and occasionally which one was used to register
            something under this domain.
          </p>
          <p>
            Finally, take a hostname from the certificate transparency search that you expect
            to be gone — a name first certificated years ago that nothing references. Resolve
            it. NXDOMAIN is the answer you want: the certificate log says this host existed,
            DNS says it does not any more, and together those two facts date a
            decommissioning. That pairing is worth more than either lookup alone, and it is why
            the playbook puts them in the same step.
          </p>
        </>
      }
    >
      <DnsLookupTool lookup={lookupDns} />
    </ToolPage>
  );
}

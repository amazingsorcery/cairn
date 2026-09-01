import Link from "next/link";
import { notFound } from "next/navigation";

import { IpIntelligenceTool } from "@/components/toolbench/ip-intelligence-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";
import { lookupIp } from "./actions";

const entry = findTool("ip-intelligence");

export const metadata = pageMetadata({
  title: "IP intelligence",
  description:
    "The covering prefix, announcing autonomous system, registry allocation country, BGP first- and last-seen dates, route visibility and abuse contact for an IP address, from RIPEstat.",
  path: "/toolbench/ip-intelligence",
});

export default function IpIntelligencePage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            An IP address on its own is a number. What makes it useful is the paperwork and the
            routing around it: which block it belongs to, who was allocated that block, which
            network announces it to the rest of the internet, and how long it has done so. This
            tool reads four{" "}
            <strong className="text-foreground">RIPEstat</strong> endpoints — the RIPE
            NCC&apos;s public interface over registry and routing data — and puts the answers on
            one page.
          </p>
          <p>
            <strong className="text-foreground">The prefix and the origin AS</strong> come from
            the global routing table. Addresses are not routed individually; they are routed in
            blocks, and each block is announced by an autonomous system with a number and a
            holder name. That holder is the network operator: a hosting company, a university,
            a telecom, a cloud provider.
          </p>
          <p>
            <strong className="text-foreground">The BGP history</strong> comes from RIPE&apos;s
            Routing Information Service, a set of collectors that have been recording the global
            routing table since 1999. It gives two dated facts — when this prefix was first seen
            and when it was last seen — and, crucially, which AS originated it on each occasion.
            When those differ, the address space changed hands, and that date belongs on your
            timeline.
          </p>
          <p>
            <strong className="text-foreground">Route visibility</strong> is a count of how many
            RIS collectors currently see the announcement. A prefix seen by nearly all of them
            is normally propagated. A prefix seen by a handful is newly announced, being
            withdrawn, or deliberately limited in scope.
          </p>
          <p>
            <strong className="text-foreground">The abuse contact</strong> is the address the
            network&apos;s own registry record nominates for reports. It is the right place to
            send one, and it is the wrong place to send an investigative enquiry.
          </p>
          <p>
            All of it is passive: registry and routing data that networks publish about
            themselves. Nothing here touches the address you are looking up.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">The country is a registry record, not a
            location.</strong> It is the country on the allocation paperwork, which is often the
            country of the organisation holding the block rather than the country the machine is
            in. A German company&apos;s address can sit in a Singapore datacentre and still read
            DE. Do not put this on a map, and do not describe it to a reader as where a server
            is.
          </p>
          <p>
            RIPEstat&apos;s commercial geolocation endpoint was withdrawn — it returned HTTP 404
            when this tool was built — so registry country is what is offered here, labelled as
            such. Measurement-based geolocation is a different technique with its own error
            characteristics, and a commercial database that guesses a city is not more truthful
            than a registry record that names a country, only more specific.
          </p>
          <p>
            <strong className="text-foreground">A less-specific match means the address itself
            is not announced.</strong> When the tool says the covering prefix is a /21, every
            fact below it describes that /21 — potentially two thousand addresses belonging to
            different customers. The holder of the block is not necessarily the operator of the
            host.
          </p>
          <p>
            <strong className="text-foreground">Shared hosting makes co-location prove
            nothing.</strong> Hundreds of unrelated sites share an address on commodity hosting,
            and a cloud address is reassigned continuously. &ldquo;These two domains resolved to
            the same IP&rdquo; is a strong link on a dedicated host and no evidence at all on
            shared infrastructure. Establish which you are looking at before you draw a line
            between anything.
          </p>
          <p>
            <strong className="text-foreground">A CDN in front changes the meaning of every
            answer.</strong> If the address came from resolving a hostname that is a CNAME to a
            CDN, this page describes the CDN. Check the alias chain in the{" "}
            <Link
              href="/toolbench/dns-lookup"
              className="font-medium text-primary underline underline-offset-4"
            >
              DNS lookup
            </Link>{" "}
            first, and if there is one, record that the origin is unknown rather than recording
            the CDN as the host.
          </p>
          <p>
            <strong className="text-foreground">Multiple origins are usually innocent.</strong>{" "}
            Anycast, a customer announcing space alongside its provider, and a migration in
            progress all produce multiple origin ASes. So does a route hijack. The tool flags
            the condition and declines to interpret it, because the interpretation needs
            context this data does not carry.
          </p>
          <p>
            <strong className="text-foreground">Routing is now; registration lags.</strong> BGP
            data reflects the present routing table, and RIPEstat&apos;s own snapshots update
            hourly rather than continuously. Registry records are updated when somebody updates
            them, which can be years after the fact. Record the date of every observation — the
            page shows you the instant it was retrieved for exactly this reason.
          </p>
          <p>
            <strong className="text-foreground">An address that hosted something last year may
            be innocent today.</strong> Infrastructure is recycled constantly. Always pair an
            address with the date on which it was observed doing whatever you are reporting, and
            treat any indicator without a date as unusable.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            Look up <code className="font-mono text-sm">193.0.6.139</code>. The covering prefix
            comes back as <code className="font-mono text-sm">193.0.0.0/21</code>, announced by
            AS3333, held by the RIPE NCC — and the panel flags it as a{" "}
            <strong className="text-foreground">less-specific match</strong>. That flag is the
            first thing to read: this address is not announced on its own, so everything on the
            page describes a block of 2,048 addresses rather than this host.
          </p>
          <p>
            Now look up <code className="font-mono text-sm">8.8.8.8</code>. The prefix is a /24
            announced by AS15169, Google. The BGP history is the interesting part: first seen in
            November 2002 originated by <strong className="text-foreground">AS21284</strong>,
            last seen today originated by <strong className="text-foreground">AS15169</strong>.
            The block changed hands. Any observation of that address from before the handover
            describes a different operator entirely, and if a threat-intelligence feed reports
            something about 8.8.8.0/24 from 2003, that report is about somebody else.
          </p>
          <p>
            Visibility reads 111 of 111 collectors — full propagation, exactly what a globally
            routed production prefix looks like. Compare that with a prefix seen by four
            collectors and first seen last week: same page, completely different story, and the
            two numbers only mean something read together.
          </p>
          <p>
            The abuse contact is published as{" "}
            <code className="font-mono text-sm">network-abuse@google.com</code>. Note it, and
            note also what emailing it would do: tell the network that somebody is looking at
            this address. If your posture is passive — and step 1 of the playbook asks you to
            decide that before you start — writing that address into your notes is the end of
            the step, not the beginning of one.
          </p>
        </>
      }
    >
      <IpIntelligenceTool lookup={lookupIp} />
    </ToolPage>
  );
}

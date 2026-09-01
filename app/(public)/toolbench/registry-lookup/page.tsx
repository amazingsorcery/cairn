import Link from "next/link";
import { notFound } from "next/navigation";

import { RegistryLookupTool } from "@/components/toolbench/registry-lookup-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("registry-lookup");

export const metadata = pageMetadata({
  title: "Aircraft and vessel identifier decoder",
  description:
    "Convert between a US N-number and an ICAO 24-bit address, find which state's block an ICAO address belongs to, and decode what an MMSI's digits say about the station it identifies.",
  path: "/toolbench/registry-lookup",
});

export default function RegistryLookupPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            An aircraft broadcasts a 24-bit ICAO address in every ADS-B message. A registry
            records a tail number. They identify the same aircraft and look nothing alike, and
            the conversion between them is not a lookup — it is arithmetic, fixed by the way the
            registering state carved up its block.
          </p>
          <p>
            <strong className="text-foreground">
              The US mapping is exact and reversible.
            </strong>{" "}
            The FAA laid out N1 to N99999 in a strict order inside{" "}
            <code className="font-mono text-sm">A00001</code>–
            <code className="font-mono text-sm">ADF7C7</code>: 915,399 registrations in 915,399
            addresses, with no gaps. Both directions are implemented here and checked against
            seventeen values published by the FAA&apos;s own inquiry system, plus a round trip
            over every address in the block. If you have a hex from a feed and want the tail
            number, or the reverse, this answers it offline in a keystroke.
          </p>
          <p>
            <strong className="text-foreground">
              The first digits of an ICAO address name the state of registry.
            </strong>{" "}
            Blocks are allocated to states, so <code className="font-mono text-sm">4CA6C4</code>{" "}
            is Irish before you know anything else about it. The table here lists only blocks
            that were checked against real aircraft observed broadcasting from them, so it is
            partial by construction and says so when an address falls outside it.
          </p>
          <p>
            <strong className="text-foreground">
              An MMSI is a structured number, not an arbitrary one.
            </strong>{" "}
            ITU-R M.585 assigns different leading digits to different kinds of station:{" "}
            <code className="font-mono text-sm">00</code> is a coast station,{" "}
            <code className="font-mono text-sm">99</code> an aid to navigation,{" "}
            <code className="font-mono text-sm">970</code> a search-and-rescue transmitter,{" "}
            <code className="font-mono text-sm">111</code> an aircraft. Knowing which you are
            looking at is often the whole answer: a &ldquo;vessel&rdquo; moving at 200 knots is
            an aircraft, and a &ldquo;vessel&rdquo; that never moves is a buoy or a base station.
          </p>
          <p>
            <strong className="text-foreground">
              Everything on this page runs in your browser and asks nothing of anyone.
            </strong>{" "}
            No request is made when you type an identifier — not to us, and not to a registry.
            That is a deliberate design and the next section explains what it costs.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">
              This tool does not query the FAA registry, and the reason is not technical.
            </strong>{" "}
            The FAA&apos;s N-Number Inquiry works, its data is US public domain, and it was used
            by hand to obtain the reference values this tool is tested against. It is not
            proxied here for three reasons, the last of which decides it: there is no API and no
            published rate limit, so there is no number an integration could respect; the
            response is a web page built for a person, so a markup change would silently produce
            wrong registry facts about a named owner; and the record includes the registrant&apos;s
            street address, which for a privately owned aircraft is somebody&apos;s home. Serving
            that from our own infrastructure would make this a personal-data lookup for aircraft
            owners, which is a thing we decline to be. The registry is linked instead, so the
            request is yours and you see its own terms.
          </p>
          <p>
            <strong className="text-foreground">
              No vessel registry is queried either, and nothing is invented in its place.
            </strong>{" "}
            No source was found during this build whose terms permit a third party to query ship
            particulars programmatically. So the vessel side decodes the number and links to
            ITU MARS, IMO GISIS and Equasis rather than pretending to a backend it does not
            have. A one-mode tool that says so beats a two-mode tool with a fictional half.
          </p>
          <p>
            <strong className="text-foreground">
              The MID-to-country list is deliberately absent.
            </strong>{" "}
            Three MID digits do name one administration, but no verifiable machine-readable copy
            of the current assignments could be confirmed for this build, and a table of two
            hundred and fifty entries written from memory would sit next to the verified
            arithmetic looking exactly as authoritative. You get the digits, the region the first
            digit denotes, and a link to the ITU&apos;s own list.
          </p>
          <p>
            <strong className="text-foreground">
              Both identifiers can be wrong, and one of them is trivially forged.
            </strong>{" "}
            An ICAO address is set in the transponder and is occasionally misconfigured; a whole
            batch of aircraft sharing an address is a known failure mode. An MMSI is programmed
            by the operator, and switching it to another vessel&apos;s number is a routine
            technique in sanctions evasion — the vessel-tracing playbook treats it as an expected
            behaviour rather than an anomaly. Decoding an identifier tells you what the
            identifier <em>says</em>. It does not tell you it is true.
          </p>
          <p>
            <strong className="text-foreground">
              The country block is the state of registry, not the operator, the owner or the
              flight.
            </strong>{" "}
            An Irish address is very often a leasing company; a Maltese one is frequently
            somebody else&apos;s fleet. Reading nationality off a hex address is how the wrong
            country ends up in a headline.
          </p>
          <p>
            <strong className="text-foreground">
              An MMSI is not a permanent identity, and an IMO number is.
            </strong>{" "}
            An MMSI changes when a vessel reflags. If you are tracing a hull across renamings,
            the identifier you actually need is the IMO number, which is why step 1 of the
            vessel playbook insists on it.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            An ADS-B feed shows an aircraft with hex{" "}
            <code className="font-mono text-sm">A7F7EF</code> and no callsign. That is a common
            situation: the address is always broadcast, the callsign often is not.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Paste <code className="font-mono text-sm">A7F7EF</code> into the aircraft field.
              The state of registry comes back as the United States, and the US registration as{" "}
              <code className="font-mono text-sm">N612UA</code>.
            </li>
            <li>
              Copy the octal form, <code className="font-mono text-sm">51773757</code>. The FAA
              prints the Mode S code in base 8 as well as base 16, and quoting the octal back is
              the fastest way to confirm you have the right aircraft rather than a
              transcription of it.
            </li>
            <li>
              Follow the FAA link and search{" "}
              <code className="font-mono text-sm">612UA</code> yourself. That request is yours,
              from your address, and you will see the federal system notice the page carries.
            </li>
          </ol>
          <p>
            Now the vessel side. A shipping database gives you{" "}
            <code className="font-mono text-sm">970244123</code> and calls it a vessel. Paste it
            in: the leading <code className="font-mono text-sm">970</code> makes it an AIS
            search-and-rescue transmitter, which is a survival-craft locating device and a
            distress indication — not a ship at all. That single check changes what the track
            means, and it takes two seconds.
          </p>
          <p>
            Try <code className="font-mono text-sm">992441234</code> as well. That is an aid to
            navigation, and a <em>virtual</em> aid to navigation is a transmission from
            somewhere else describing a mark that may not physically exist. A track that never
            moves is not a vessel at anchor until you have checked which of these it is.
          </p>
          <p>
            Both of these feed step 1 of the{" "}
            <Link
              href="/playbooks/tracing-a-vessel-and-its-owner"
              className="font-medium text-primary underline underline-offset-4"
            >
              vessel-tracing playbook
            </Link>
            , which is about fixing an identity precisely before spending a day on the wrong
            hull.
          </p>
        </>
      }
    >
      <RegistryLookupTool />
    </ToolPage>
  );
}

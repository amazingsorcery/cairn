import Link from "next/link";
import { ExternalLink, Laptop, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { pageMetadata } from "@/lib/metadata";
import {
  DATA_HANDLING_LABEL,
  TOOL_GROUPS,
  type DataHandling,
  type ToolbenchEntry,
  toolsInGroup,
} from "@/lib/toolbench/registry";

/**
 * The Toolbench index.
 *
 * Pillar B of the product brief: utilities that genuinely run here rather than links out.
 * The card for each tool leads with what it does and how it handles data, because for this
 * audience the second question is not a detail — a journalist choosing where to open a
 * source's photograph is deciding whose servers see it.
 *
 * Everything on this page is static. It reads a hand-maintained registry, not the database,
 * and `lib/toolbench/registry.test.ts` asserts that the registry and the route directory
 * agree, so an index card can never point at a route that does not exist.
 */

export const metadata = pageMetadata({
  title: "Toolbench",
  description:
    "Working OSINT utilities hosted here: hashes and encodings, timestamp and coordinate conversion, solar geometry for chronolocation, image metadata and a metadata scrubber — all in your browser — plus certificate transparency, DNS, IP and web-archive lookups against public sources.",
  path: "/toolbench",
});

/**
 * The badge each data-handling value gets, and why the third is `outline` rather than
 * `warning`: querying a public routing registry on somebody's behalf is not the same kind of
 * disclosure as uploading their source's photograph to a search engine, and colouring the two
 * identically would either alarm readers about the first or reassure them about the second.
 */
const HANDLING_BADGE: Readonly<
  Record<DataHandling, { variant: "success" | "warning" | "outline"; Icon: typeof Laptop }>
> = {
  inBrowser: { variant: "success", Icon: Laptop },
  opensThirdParty: { variant: "warning", Icon: ExternalLink },
  onOurServer: { variant: "outline", Icon: Server },
  /*
   * Same badge as `onOurServer`, because the reader's disclosure is the same: the query
   * reaches an upstream and never their address. The difference between the two values is
   * whether routing it through us was a necessity or a choice, which is a sentence on the
   * page rather than a colour on a card.
   */
  viaOurServer: { variant: "outline", Icon: Server },
  /*
   * `warning`, alongside the reverse-image launcher, and for the same reason: this is the
   * other value where the reader's own browser reaches a third party. It is the only one of
   * the five where the source learns the reader's address.
   */
  clientToSource: { variant: "warning", Icon: ExternalLink },
};

function ToolCard({ entry }: { entry: ToolbenchEntry }) {
  const { variant, Icon } = HANDLING_BADGE[entry.dataHandling];
  return (
    <li>
      <Link
        href={`/toolbench/${entry.slug}`}
        className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
      >
        <h3 className="font-semibold leading-tight tracking-tight">{entry.name}</h3>
        <p className="flex-1 text-sm leading-relaxed text-foreground-secondary">{entry.summary}</p>
        <Badge variant={variant} className="self-start">
          <Icon className="size-3" aria-hidden="true" />
          {DATA_HANDLING_LABEL[entry.dataHandling]}
        </Badge>
      </Link>
    </li>
  );
}

export default function ToolbenchPage() {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <header className="max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Toolbench</h1>
        <p className="mt-3 text-lg text-foreground-secondary">
          Utilities that run here rather than pointing somewhere else. Most of them do their
          work inside your own browser: no file, no coordinate and no token you type is sent
          anywhere, because there is no request that would carry it.
        </p>
        <p className="mt-4 text-base leading-relaxed text-foreground-secondary">
          The four domain and network tools are the exception, and every card says so. They
          query public sources — a certificate log, a public resolver, a routing registry, a
          web archive — that a web page is not permitted to call directly, so the query goes to
          our server and our server asks on your behalf. The source sees us rather than you.
          It does see what you asked about. We record that a lookup happened and how it ended,
          and never what was looked up: there is no column in our audit log that could hold it.
        </p>
        <p className="mt-4 text-base leading-relaxed text-foreground-secondary">
          Each tool explains the technique it implements and what would make its answer wrong,
          works through an example, and links to the playbook step it belongs to. A tool that
          produces a number without telling you how to read it is half a tool.
        </p>
      </header>

      {TOOL_GROUPS.map((group) => (
        <section key={group.id} aria-labelledby={`${group.id}-heading`} className="mt-12">
          <h2 id={`${group.id}-heading`} className="text-xl font-semibold tracking-tight">
            {group.label}
          </h2>
          <p className="mt-2 max-w-[68ch] text-base leading-relaxed text-foreground-secondary">
            {group.blurb}
          </p>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {toolsInGroup(group.id).map((entry) => (
              <ToolCard key={entry.slug} entry={entry} />
            ))}
          </ul>
        </section>
      ))}

      <section aria-labelledby="not-here-heading" className="mt-16 max-w-[68ch]">
        <h2 id="not-here-heading" className="text-xl font-semibold tracking-tight">
          What is deliberately not here
        </h2>
        <div className="mt-3 space-y-4 text-base leading-relaxed text-foreground-secondary">
          <p>
            <strong className="text-foreground">what3words conversion.</strong> The wordlist is
            proprietary and not licensed for reimplementation, so the only way to offer it
            would be to send your coordinate to their servers — which would break the promise
            the rest of this page makes. The open equivalent, Plus Codes, is implemented in
            full in the coordinate converter, and the reason is stated on that page too.
          </p>
          <p>
            <strong className="text-foreground">Anything that looks like verification but
            is not.</strong> The JWT tool decodes and never claims to verify, because
            verification needs the signing key. The thumbnail comparison reports a difference
            and does not pronounce on whether an image was manipulated. Where a technique can
            only narrow a question rather than answer it, the tool says so at the point where
            you would otherwise over-read the result.
          </p>
          <p>
            <strong className="text-foreground">WHOIS and registration lookups.</strong> The
            DNS tool stops at four record types rather than adding a fifth. Registration data
            is published by hundreds of separate registries under terms that differ registry by
            registry, most of it is redacted under GDPR, and what remains is personal data we
            would then be processing on behalf of someone who never contacted us. An honest
            four-record tool is better than a fifth panel whose legal basis we could not state.
          </p>
          <p>
            Tools we do not host are{" "}
            <Link href="/directory" className="font-medium text-primary underline underline-offset-4">
              catalogued in the directory
            </Link>{" "}
            with their cost, licence and jurisdiction, which is a different job from running
            them.
          </p>
        </div>
      </section>
    </div>
  );
}

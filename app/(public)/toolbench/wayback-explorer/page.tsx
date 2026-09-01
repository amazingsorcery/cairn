import { notFound } from "next/navigation";

import { ToolPage } from "@/components/toolbench/tool-page";
import { WaybackExplorerTool } from "@/components/toolbench/wayback-explorer-tool";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";
import { fetchCaptures, lookupTimeline } from "./actions";

const entry = findTool("wayback-explorer");

export const metadata = pageMetadata({
  title: "Wayback capture explorer",
  description:
    "Every archived capture of a URL on one timeline, the dates its content actually changed read from the archive's own index digests, and a text comparison between any two captures.",
  path: "/toolbench/wayback-explorer",
});

export default function WaybackExplorerPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            Most people use the Wayback Machine by picking a date on a calendar and reading the
            page. That works, and it is the slow way. The archive also publishes its{" "}
            <strong className="text-foreground">index</strong> — the CDX server — which lists
            every capture of a URL with its timestamp, its HTTP status, its size, and a{" "}
            <strong className="text-foreground">content digest</strong>: a hash of the bytes
            the crawler received.
          </p>
          <p>
            The digest is what makes the index more useful than the pages. Two consecutive
            captures with the same digest are byte-identical, so the page did not change
            between them. A digest that differs from the one before it is the archive telling
            you the page changed — and it tells you that{" "}
            <strong className="text-foreground">without downloading either capture</strong>. A
            page crawled four hundred times over fifteen years might have changed nine times,
            and those nine dates are the ones worth your attention.
          </p>
          <p>
            This tool asks the index for the whole history, collapsing consecutive identical
            digests, and renders it three ways: captures per year, the dated list of changes,
            and a picker for comparing any two captures.
          </p>
          <p>
            The comparison fetches both captures in the archive&apos;s{" "}
            <em>unmodified</em> form — the raw bytes it received, without the archive&apos;s
            own toolbar and without its link rewriting — reduces each to readable text, and
            diffs them line by line. Excluding the archive&apos;s scaffolding matters: with it
            included, two captures a year apart differ in hundreds of lines of injected markup
            and the actual editorial change is buried.
          </p>
          <p>
            Everything here is passive with respect to the site you are investigating. The
            requests go to the Internet Archive.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">A gap in captures is almost never a gap in the
            site.</strong> This is the most over-read signal in archival research. Crawl
            frequency follows a page&apos;s popularity and inbound links, so an obscure page is
            captured rarely and a prominent one many times a day. &ldquo;There are no captures
            between 2013 and 2016&rdquo; is a fact about crawler coverage. It is not evidence
            that the site was down, and it is certainly not evidence that it did not exist.
          </p>
          <p>
            <strong className="text-foreground">Absence of a URL is not absence of a
            page.</strong> The archive normalises the host — a search for{" "}
            <code className="font-mono text-sm">example.com/a</code> does find captures of{" "}
            <code className="font-mono text-sm">www.example.com/a</code> — but the{" "}
            <em>path and query string are matched exactly</em>. A page indexed as{" "}
            <code className="font-mono text-sm">/about/</code> is not found by asking for{" "}
            <code className="font-mono text-sm">/about</code>, and a URL with a query string is
            a different entry from the same path without it. Try the variants before concluding
            that something was never captured.
          </p>
          <p>
            <strong className="text-foreground">A digest change is not necessarily an
            editorial change.</strong> The digest covers the whole response body. A rotating
            advertisement, a changed session token, a random comment, a timestamp in the
            footer, a redesign that touched no words — all of them change the digest. Equally,
            a page can be edited in a way that leaves the archived bytes untouched if the
            change was in content loaded by script, which the crawler did not capture.
          </p>
          <p>
            <strong className="text-foreground">The diff compares words, not
            appearance.</strong> Both captures are reduced to readable text before comparison,
            deliberately. A redesign that changed the layout and none of the copy shows up here
            as no change. A change to an image, a video or a chart shows up as nothing at all.
            Open the captures at the archive when appearance is what you are investigating.
          </p>
          <p>
            <strong className="text-foreground">The archive is not a complete or neutral
            record.</strong> Crawlers miss pages behind logins, forms, paywalls and scripts.
            Historically the archive honoured robots.txt retroactively, so a site that added an
            exclusion could remove its own past from public view, and pages are still removed
            on request by the publisher. What you see is what was captured{" "}
            <em>and is still shown</em>, which is not the same as what existed.
          </p>
          <p>
            <strong className="text-foreground">The capture time is the crawl time, not the
            publication time.</strong> A capture on 12 March tells you the page looked like that
            on 12 March. It says nothing about when the text was written, and if the previous
            capture was eight months earlier, the change could have happened on any of those
            days.
          </p>
          <p>
            <strong className="text-foreground">Dynamic pages archive badly.</strong> A page
            assembled by JavaScript from an API often archives as an empty shell. An empty text
            extraction usually means the crawler captured a shell, not that the page was blank
            — and archive.today, which renders before capturing, frequently holds a more
            faithful copy of exactly those pages.
          </p>
          <p>
            <strong className="text-foreground">Capture what you cite, yourself.</strong> If a
            capture matters to a published claim, save your own copy and record its digest. A
            reference to a snapshot that is later removed is a reference to nothing.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            Load the timeline for <code className="font-mono text-sm">ripe.net</code>. The
            archive returns captures reaching back to May 1997 — the year-by-year chart shows
            almost nothing until 2000, then a steady climb, which is a picture of the
            archive&apos;s own growth rather than of the site.
          </p>
          <p>
            Read the change list rather than the capture list. Consecutive identical digests are
            collapsed away, so what is left is the dates the page actually differed from the
            crawl before it. That is the column you copy into an infrastructure timeline
            alongside the certificate first-seen dates and the BGP first-seen date; convergence
            across those three is what makes a &ldquo;the operator changed here&rdquo; claim
            defensible.
          </p>
          <p>
            Now pick the earliest capture and one from a decade later and compare them. The
            1997 capture reduces to a few dozen lines of text; the later one to hundreds. Nearly
            everything is marked added, which is exactly what you would expect and is not a
            useful result — a diff across a redesign is noise.
          </p>
          <p>
            The useful comparison is a narrow one. Take two captures on either side of a{" "}
            <em>single</em> change point — the change list gives you both timestamps — and the
            diff collapses to a handful of lines. That is where you find the sentence that was
            removed, the name that was taken off the team page, the pricing that changed, or the
            claim that quietly softened. One or two lines, dated to within the gap between two
            crawls, with the archive&apos;s own URL to cite.
          </p>
          <p>
            Then check the gap between those two captures before you write anything. If they are
            three days apart you have dated the change to three days. If they are eleven months
            apart you have dated it to eleven months, and saying more than that is not supported
            by what you have.
          </p>
        </>
      }
    >
      <WaybackExplorerTool lookupTimeline={lookupTimeline} fetchCaptures={fetchCaptures} />
    </ToolPage>
  );
}

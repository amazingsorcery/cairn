import Link from "next/link";
import { notFound } from "next/navigation";

import { ReverseImageTool } from "@/components/toolbench/reverse-image-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("reverse-image-search");

export const metadata = pageMetadata({
  title: "Reverse image search launcher",
  description:
    "Open Google Lens, Yandex, Bing and TinEye against the same image at once, with what each engine is good at and what their collective silence actually means.",
  path: "/toolbench/reverse-image-search",
});

export default function ReverseImageSearchPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            Reverse image search asks an index whether it has seen this picture, or something
            close to it, before. The four engines here are worth running together because they
            fail differently: they crawl different parts of the web, they weight visual
            similarity differently, and the one that finds your image is rarely predictable in
            advance.
          </p>
          <p>
            <strong className="text-foreground">Google Lens</strong> is strongest at
            recognising what is <em>in</em> the frame — landmarks, products, signage, which it
            will also translate. It is weakest at finding other copies of the same photograph.{" "}
            <strong className="text-foreground">Yandex</strong> is consistently the best at
            near-duplicates and at buildings and faces in eastern Europe and central Asia,
            where the others have thin coverage.{" "}
            <strong className="text-foreground">Bing</strong> will search a cropped region and
            often surfaces stock and commercial sources.{" "}
            <strong className="text-foreground">TinEye</strong> is the only one that sorts by
            oldest first, which is the sort order you want when the question is where a picture
            appeared <em>first</em>.
          </p>
          <p>
            If you have a public URL for the image, the launcher builds each engine&apos;s
            search-by-URL address and opens all four. If you have the file, it opens the four
            upload pages and shows you a local preview so you can confirm which picture you are
            about to hand over — because no engine accepts a file through a link, and a page
            that appeared to submit one for you would have to route it through a server. This
            application does not have one for that, by design.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">This hands your image to four
            companies.</strong> Nothing goes to this site — the links go straight from your
            browser to theirs — but that is not the same as nothing happening. Each engine
            keeps its own record of what was searched and when, under its own jurisdiction:
            Google and Microsoft in the United States, Yandex in Russia, TinEye in Canada. If
            the picture came from a source who would be endangered by it circulating, weigh
            that before opening anything, and consider searching a cropped, non-identifying
            region instead of the whole frame.
          </p>
          <p>
            <strong className="text-foreground">Searching by URL discloses to the host
            too.</strong> The engine fetches the image from the address you give it, so
            whoever hosts that image sees the request. If the image sits on a site the subject
            of your investigation controls, they will see engines fetching it, and the timing
            is a signal. Download a copy and use the file path instead.
          </p>
          <p>
            <strong className="text-foreground">Silence means the picture is not indexed,
            not that it is original.</strong> Reverse image search finds published copies. Most
            images taken by most people have never been indexed by anything. A negative result
            from all four says nothing about authenticity and nothing about whether the picture
            is what it claims to be.
          </p>
          <p>
            <strong className="text-foreground">Indexing is slow and partial.</strong> An image
            posted an hour ago, posted inside a closed group, or posted on a platform that
            blocks crawlers will not be found however many engines you try. So try again in a
            week; the answer genuinely changes.
          </p>
          <p>
            <strong className="text-foreground">A match is a lead, not a source.</strong> The
            page an engine returns is very often a re-post of a re-post. Follow it back and
            establish who published it first, with a date you can check, before treating it as
            provenance.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            An image circulates claiming to show flooding in a named city this week. Before
            spending a day on geolocation, spend two minutes here.
          </p>
          <p>
            Save the image and open the file tab. Confirm the preview is the picture you mean,
            then open all four upload pages and drop the file into each. TinEye is the one to
            read first, because it sorts by oldest: if it returns a result from four years ago
            on a news site in a different country, the claim is answered and the rest of the
            work is unnecessary.
          </p>
          <p>
            Suppose instead that all four find nothing. That is the normal outcome and it means
            almost nothing on its own. Three things to try before concluding: crop to a
            distinctive building or sign and search that — engines match whole frames and often
            miss a scene they would recognise in isolation; search a horizontally flipped copy,
            because mirroring is the standard way to evade matching and costs one more search
            to defeat; and if the material is video, pull keyframes and search those, since
            there is no video-native reverse search worth the name.
          </p>
          <p>
            Then go and do the manual work: the{" "}
            <Link
              href="/playbooks/geolocating-from-imagery"
              className="font-medium text-primary underline underline-offset-4"
            >
              geolocating from imagery
            </Link>{" "}
            playbook picks up exactly here, and the{" "}
            <Link
              href="/toolbench/sun-position"
              className="font-medium text-primary underline underline-offset-4"
            >
              sun position tool
            </Link>{" "}
            is what tests the &quot;this week&quot; half of the claim once you have a location.
          </p>
        </>
      }
    >
      <ReverseImageTool />
    </ToolPage>
  );
}

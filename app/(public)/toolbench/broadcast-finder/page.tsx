import Link from "next/link";
import { notFound } from "next/navigation";

import { BroadcastTool } from "@/components/toolbench/broadcast-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { isSignInEnabled } from "@/lib/session-surface";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("broadcast-finder");

export const metadata = pageMetadata({
  title: "Broadcast finder",
  description:
    "Find public internet radio streams by country, region, language or name, and listen to them directly from the broadcaster — with the fifth of the catalogue a browser cannot play labelled rather than hidden.",
  path: "/toolbench/broadcast-finder",
});

export default function BroadcastFinderPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            Local radio is one of the few sources that is live, local and outside the social
            platforms. During an unfolding event it carries names, road closures, official
            statements and local reaction hours before any of it is written down, and in
            languages the international wires are not covering. It is also, unlike almost
            everything else in this workbench, a source you consume rather than query.
          </p>
          <p>
            <strong className="text-foreground">
              This searches the whole catalogue, and that is the point.
            </strong>{" "}
            The Radio Browser project maintains a community catalogue of roughly 58,000
            stations. Fewer than a quarter of them carry coordinates, so anything built to draw
            stations on a map has to filter to the geolocated ones — and a search built on that
            filter would cover under a quarter of the catalogue while looking complete. On a real
            search for Dutch-language news, the two obvious answers, NPO Radio 1 and BNR
            Nieuwsradio, both have no coordinates at all. So this queries by country, region,
            language, tag and name instead, with no geographic filter anywhere in the request.
          </p>
          <p>
            <strong className="text-foreground">
              The search goes through this site. The audio does not.
            </strong>{" "}
            Two different things, on purpose. The catalogue query is made by our server, so the
            project never learns your address or that you were looking for stations in a
            particular oblast. The audio then plays from a direct connection between your
            browser and the broadcaster, with nothing passing through us — relaying it would
            turn a linking site into a rebroadcasting one, and fifty concurrent listeners would
            cost about a thousand times this deployment&apos;s entire traffic budget. We also
            decline to send the catalogue&apos;s optional click-tracking call, which would tell
            a third party which station each reader opened.
          </p>
          <p>
            <strong className="text-foreground">
              The consequence is that the broadcaster sees you.
            </strong>{" "}
            Pressing play opens a connection from your machine to their server, so your address
            reaches the station. That is unavoidable for anything that is not a relay, and it is
            worth thinking about before you listen to a state broadcaster in a country you are
            reporting on.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">
              About a fifth of the catalogue cannot play on this page, and they are shown
              anyway.
            </strong>{" "}
            Those stations publish a plain <code className="font-mono text-sm">http:</code>{" "}
            stream URL, which every browser blocks as mixed content on an{" "}
            <code className="font-mono text-sm">https:</code> page — silently, with no error the
            page can detect. So they get a link that opens outside this page rather than a play
            button that would do nothing at all. Hiding them would be worse: a fifth of the
            catalogue missing with no explanation is the same silent incompleteness as filtering
            to geolocated stations.
          </p>
          <p>
            <strong className="text-foreground">The catalogue is community-edited.</strong>{" "}
            Country, region and language are typed in by whoever added the station, and they are
            inconsistent. A station in Kharkiv may have no region at all; a Ukrainian station may
            be filed under <code className="font-mono text-sm">russian</code> because that is
            what it broadcasts in. If a filter returns nothing, widen it before concluding
            anything — an empty result here is usually about the metadata, not about the place.
          </p>
          <p>
            <strong className="text-foreground">
              &ldquo;Working&rdquo; means the project&apos;s checker reached it, at some point.
            </strong>{" "}
            The last-checked time in the table is when an automated check last succeeded. A
            station that failed one check an hour ago may be perfectly on air, and during an
            outage — which is exactly when you are looking — that station is the one you want.
            The filter that hides broken stations can be turned off for that reason.
          </p>
          <p>
            <strong className="text-foreground">HLS streams need Safari or a helper.</strong>{" "}
            Streams tagged HLS play natively in Safari and in very few other browsers. Elsewhere
            the player appears and stays silent, which is why they are labelled — an unlabelled
            silent player is indistinguishable from a broken tool.
          </p>
          <p>
            <strong className="text-foreground">
              A station&apos;s listed country is where it is registered, not where it is heard.
            </strong>{" "}
            Diaspora stations, satellite feeds and rebroadcasts are all in the catalogue under
            whichever country somebody typed. For establishing what local audiences were
            actually hearing, the station&apos;s own site — linked on every row — is the thing to
            check.
          </p>
          <p>
            <strong className="text-foreground">
              Listening is not evidence until you record what you heard.
            </strong>{" "}
            A stream leaves no artefact. Note the station, the exact time in UTC, and what was
            said,{" "}
            {/*
              The link is to a route that only exists where somebody can sign in. In
              public-only mode `/workspaces` answers 404 (ADR 0032), so the sentence keeps its
              instruction — which is the part that matters to the reader — and drops the
              pointer to a page that is not served.
            */}
            {isSignInEnabled() ? (
              <>
                in your{" "}
                <Link
                  href="/workspaces"
                  className="font-medium text-primary underline underline-offset-4"
                >
                  workspace
                </Link>{" "}
              </>
            ) : (
              <>in your notes </>
            )}
            as you listen — a claim about a broadcast you cannot timestamp is not a citation.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            A video is circulating that claims to show an explosion in a Ukrainian city this
            morning. You have geolocated it and you now want an independent, contemporaneous
            source that the video&apos;s publisher does not control.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Set the country code to <code className="font-mono text-sm">UA</code> and the
              language to <code className="font-mono text-sm">ukrainian</code>, leave the tag
              empty, and search. Do not start with a region — region is free text and the
              likeliest cause of a false empty.
            </li>
            <li>
              Look at the counts the tool reports: how many stations came back, and how many of
              those are <code className="font-mono text-sm">http:</code> only. If the second
              number is most of them, you are working with a smaller playable set than the
              result count suggests, and you should say so in your notes.
            </li>
            <li>
              Add the tag <code className="font-mono text-sm">news</code> and search again. Note
              whether the station you were about to rely on survives that filter — if it does
              not, its own operator has not described it as news.
            </li>
            <li>
              Play a station that streams over <code className="font-mono text-sm">https</code>.
              Write down the station name, the stream host shown in the player, and the UTC time
              you started listening, before you write down anything you hear.
            </li>
          </ol>
          <p>
            <strong className="text-foreground">Then read the silence correctly.</strong> If
            local radio is not mentioning it, that is weak evidence and not a debunk: a station
            may be off air, may be running scheduled programming, may be under a reporting
            restriction, or may simply not have it yet. Absence of local coverage constrains
            nothing on its own. What it does do is tell you which question to ask next — and if
            you can hear local coverage that contradicts the claim, in a language and on a
            station the publisher does not control, that is a much stronger finding than
            anything you will get from another search engine.
          </p>
          <p>
            Now do the same search with the country code alone, no language. Compare the counts.
            The difference between the two is a measure of how much the catalogue&apos;s language
            metadata is doing for you, and it is usually larger than people expect.
          </p>
        </>
      }
    >
      <BroadcastTool />
    </ToolPage>
  );
}

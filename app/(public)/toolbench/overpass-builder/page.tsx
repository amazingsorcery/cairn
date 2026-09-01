import Link from "next/link";
import { notFound } from "next/navigation";

import { OverpassTool } from "@/components/toolbench/overpass-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("overpass-builder");

export const metadata = pageMetadata({
  title: "Overpass query builder",
  description:
    "Search OpenStreetMap for where a combination of mapped features occurs inside a bounding box, see the Overpass QL that does it, and read the results on a map and in a table.",
  path: "/toolbench/overpass-builder",
});

export default function OverpassBuilderPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            OpenStreetMap is not a picture of the world, it is a database about it. Every water
            tower, level crossing and football pitch somebody has mapped carries tags —{" "}
            <code className="font-mono text-sm">man_made=water_tower</code>,{" "}
            <code className="font-mono text-sm">railway=level_crossing</code> — and the Overpass
            API lets you ask where those tags occur. That turns geolocation from recognising a
            place into eliminating everywhere it cannot be.
          </p>
          <p>
            <strong className="text-foreground">The power is in co-occurrence.</strong> Water
            towers are everywhere. Football pitches are everywhere. Places where a water tower,
            a football pitch and a level crossing sit within a few hundred metres of each other,
            inside one province, may number in single digits. Each feature you add multiplies
            the constraint, and the query costs the same twenty seconds either way.
          </p>
          <p>
            <strong className="text-foreground">Why the query is shown.</strong> A builder that
            hides its query teaches nobody anything, and you will meet Overpass QL again — in
            overpass-turbo, in other people&apos;s published methodology, in the next
            investigation. So the generated query is on the page, it is editable, and the exact
            text that ran is printed under the results.
          </p>
          <p>
            <strong className="text-foreground">
              Where the request goes, and what it costs somebody else.
            </strong>{" "}
            The query is submitted by this site&apos;s server, not by your browser, so the
            Overpass operators see us rather than you — a bounding box is the patch of the world
            you are investigating, and that is not a thing to hand out. The other side of that
            coin is that the public Overpass instances are a donated community service. Their
            own usage guidance names &ldquo;an app relying on the public instances as
            backend&rdquo; as problematic behaviour, and we are that. So every query here is
            bounded, capped, rate-limited well below their published guidance, cached and shared
            across everyone who asks the same thing — and the tool points you at overpass-turbo
            for exploratory work, where the cost falls on your own connection instead.
          </p>
          <p>
            <strong className="text-foreground">The grammar is narrower than Overpass QL.</strong>{" "}
            Whatever you type is parsed back into a structure and re-emitted before it is sent,
            so the text that reaches the server is always one this site generated — the same
            discipline as a parameterised database query. The cost is that{" "}
            <code className="font-mono text-sm">area</code>,{" "}
            <code className="font-mono text-sm">around:</code>, recursion, set variables and
            regular-expression matches are all refused, because each of them can leave the
            bounding box or cost the shared server far more than a bounded query. The tool says
            which construct it refused and why, rather than saying &ldquo;invalid query&rdquo;.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">
              A null result is usually about the map, not about the world.
            </strong>{" "}
            In descending order of likelihood: the query is wrong; the feature is not tagged in
            OpenStreetMap in that region; local tagging convention differs from the one you
            assumed; the feature is not there. Test the query somewhere the feature definitely
            exists before you conclude anything from an empty list.
          </p>
          <p>
            <strong className="text-foreground">Coverage is wildly uneven.</strong> The power
            network and the rail network are mapping projects in their own right and are close
            to complete across much of Europe and North America. Masts, helipads and industrial
            structures are patchy nearly everywhere. Military land is mapped inconsistently and
            for political reasons in some countries, so both its presence and its absence need
            care. Nothing in a result set tells you how completely the area was surveyed.
          </p>
          <p>
            <strong className="text-foreground">
              One tag is rarely the feature you mean.
            </strong>{" "}
            <code className="font-mono text-sm">leisure=pitch</code> returns tennis courts;{" "}
            <code className="font-mono text-sm">power=generator</code> returns diesel sets as
            well as wind turbines; <code className="font-mono text-sm">amenity=hospital</code>{" "}
            covers a village clinic in some countries and only major hospitals in others. The
            presets here add the second tag where it is needed and say so; when you edit the
            query, that is the first thing to check.
          </p>
          <p>
            <strong className="text-foreground">
              A returned point is a representative point, not the thing.
            </strong>{" "}
            <code className="font-mono text-sm">out center</code> gives one coordinate per
            feature — for a runway that is the middle of the strip, not either threshold; for a
            quarry it is the centroid of an irregular area. Do not measure distances from it
            without opening the feature on OpenStreetMap first.
          </p>
          <p>
            <strong className="text-foreground">
              A partial answer arrives as a success.
            </strong>{" "}
            When a query exceeds its declared run time Overpass answers HTTP 200 with a{" "}
            <code className="font-mono text-sm">remark</code> and whatever rows it had managed.
            This tool surfaces that remark above the results in red, because a partial list read
            as a complete one is how &ldquo;there is no water tower in this box&rdquo; gets into
            a published story.
          </p>
          <p>
            <strong className="text-foreground">
              OpenStreetMap is a moving target with an edit history.
            </strong>{" "}
            The extract timestamp under the results is when the database behind the answer was
            cut. A feature may have been added last week or deleted last month, and the edit
            history on openstreetmap.org — linked from every row — is itself evidence worth
            reading when a feature appears or disappears at a convenient moment.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            You have a photograph showing a water tower with a level crossing in the middle
            distance. The claim attached to it names a town. That is a claim, not a location,
            and it is testable in about two minutes.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Leave the two ticked presets as they are —{" "}
              <strong className="text-foreground">Water tower</strong> and{" "}
              <strong className="text-foreground">Level crossing</strong> — and leave the
              bounding box at its default,{" "}
              <code className="font-mono text-sm">50.62, 3.00, 50.68, 3.10</code>. That is about
              47 km&sup2; over Roubaix and Tourcoing, north-east of Lille.
            </li>
            <li>
              Read the query before you run it. The bounding box is in the settings line, as{" "}
              <code className="font-mono text-sm">[bbox:&hellip;]</code>, which is what makes
              every statement inside the union bounded. The two{" "}
              <code className="font-mono text-sm">nwr</code> lines are your two features. The
              last line asks for one representative point each.
            </li>
            <li>
              Run it. When this example was checked against the live API on 1 September 2026 it
              returned <strong className="text-foreground">45 features — 7 water towers and 38
              level crossings</strong>. Your numbers will differ, because OpenStreetMap changes
              daily; the extract timestamp under the results tells you when the database behind
              your answer was cut.
            </li>
            <li>
              Now do the analysis the query cannot do for you: compare coordinates and find the
              pairs close enough to appear in one frame. Seven water towers against
              thirty-eight crossings is not seven times thirty-eight candidates — it is however
              many pairs are within a few hundred metres of each other, which is a much smaller
              number and is the whole point of querying for co-occurrence.
            </li>
            <li>
              Check the survivors against imagery with the{" "}
              <Link
                href="/toolbench/imagery-comparator"
                className="font-medium text-primary underline underline-offset-4"
              >
                imagery comparator
              </Link>{" "}
              or a street-level platform, and record which candidates you eliminated and why.
            </li>
          </ol>
          <p>
            <strong className="text-foreground">Now run the control, and mean it.</strong> Put
            the box over Erdington in north Birmingham —{" "}
            <code className="font-mono text-sm">52.51, -1.87, 52.55, -1.80</code> — and run the
            same query. On 1 September 2026 that returned{" "}
            <strong className="text-foreground">nothing at all</strong>: not one water tower,
            not one level crossing, in eight square kilometres of a British city that certainly
            has railways crossing roads.
          </p>
          <p>
            That null is the most useful thing on this page. It is not a statement about
            Birmingham; it is a statement about how completely those two tags have been applied
            there, and it is exactly the result that would have led you to eliminate a correct
            candidate. Run the control <em>before</em> you conclude anything from an empty list,
            every time — it costs one query and it is the difference between a method and a
            guess.
          </p>
        </>
      }
    >
      <OverpassTool />
    </ToolPage>
  );
}

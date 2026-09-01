import Link from "next/link";
import { notFound } from "next/navigation";

import { ImageryComparator } from "@/components/toolbench/imagery-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("imagery-comparator");

export const metadata = pageMetadata({
  title: "Satellite imagery comparator",
  description:
    "Compare NASA satellite imagery of the same place on two dates, side by side or with a swipe, using MODIS and VIIRS daily global coverage back to 2000.",
  path: "/toolbench/imagery-comparator",
});

export default function ImageryComparatorPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            NASA&apos;s Global Imagery Browse Services publishes a daily global mosaic from the
            MODIS and VIIRS instruments, back to February 2000, as ordinary map tiles with no
            key and no registration. Put two dates side by side over the same ground and
            anything that changed between them is visible without any interpretation at all.
          </p>
          <p>
            <strong className="text-foreground">
              What &ldquo;true colour&rdquo; and &ldquo;bands 7-2-1&rdquo; mean.
            </strong>{" "}
            True colour is roughly what your eye would see from orbit. Bands 7-2-1 substitutes
            shortwave infrared for red: burned ground turns brick red, actively burning fire is
            bright red-orange, healthy vegetation is green, and smoke becomes nearly
            transparent. That last property is why it matters — a fire&apos;s footprint is
            visible <em>through its own plume</em>, which true colour cannot show you.
          </p>
          <p>
            <strong className="text-foreground">Why there are four platforms.</strong> Terra
            crosses in the morning and Aqua in the early afternoon; Suomi NPP and NOAA-20 are
            about fifty minutes apart in the afternoon. Cloud that hides a site on one pass may
            have cleared on another the same day. Checking one platform and concluding &ldquo;no
            imagery&rdquo; is one of the commonest mistakes with this data.
          </p>
          <p>
            <strong className="text-foreground">
              The tiles come from NASA to your browser, not through us.
            </strong>{" "}
            That is the correct arrangement for imagery — relaying it would make this a
            rebroadcasting service and would exhaust a small server in hours — and it has a
            consequence worth stating plainly: NASA sees your address and the exact area you
            request. On a comparator, the area you request <em>is</em> the investigation. The
            maps are therefore not loaded until you ask, and the gate says so before the first
            tile.
          </p>
          <p>
            <strong className="text-foreground">Dates are UTC satellite days.</strong> A pass
            over eastern Australia late on the 5th local time is stamped the 5th in UTC; a pass
            over Hawaii at the same instant is the 4th. When you are testing a claim about a
            specific evening, look at both days.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">
              The resolution is about 300 metres per pixel. This is the limit that matters
              most.
            </strong>{" "}
            One pixel is three football pitches end to end. You cannot see a vehicle, a
            building, a crater or a person. You can see a flood, a burn scar, a smoke plume, a
            snow line, a dust storm, a dried reservoir, a large new excavation, and a city that
            has gone dark. If your question needs more than that, this is the wrong instrument
            — Sentinel-2 at 10 m and commercial imagery below 1 m are what the{" "}
            <Link
              href="/directory"
              className="font-medium text-primary underline underline-offset-4"
            >
              directory
            </Link>{" "}
            lists for it.
          </p>
          <p>
            <strong className="text-foreground">
              Zooming in past the deepest tiles is enlargement, not detail.
            </strong>{" "}
            The interface prints the metres-per-pixel figure and warns you when you have gone
            past the point where more information exists. Everything beyond it is the same
            pixels, bigger. Analysts over-read those pixels constantly, and a confident claim
            about a 300-metre smear is the classic failure with this data.
          </p>
          <p>
            <strong className="text-foreground">Blank areas are not empty ground.</strong> Gaps
            between orbital swaths, polar night, and processing failures all produce tiles that
            simply do not exist; the service answers 404 and this tool draws nothing rather than
            a broken image. &ldquo;Nothing there&rdquo; on this map may mean nothing was
            observed there that day.
          </p>
          <p>
            <strong className="text-foreground">
              Cloud is the normal case, not the exception.
            </strong>{" "}
            Much of the world is under cloud most of the time. A pair of dates that both show
            cloud is not evidence of anything, and the temptation to read a change between one
            cloudy image and one clear one as a change on the ground is strong. Step through the
            days either side before drawing a conclusion.
          </p>
          <p>
            <strong className="text-foreground">Colour shifts are not always change.</strong>{" "}
            Sun angle, haze, aerosol, snow and seasonal vegetation all move the colours between
            two dates. So do the instruments themselves: MODIS and VIIRS render the same scene
            slightly differently. Compare like with like — the same layer on both sides — before
            you compare across platforms.
          </p>
          <p>
            <strong className="text-foreground">
              The night-lights layer stops on 7 July 2023.
            </strong>{" "}
            That product is no longer being produced into GIBS. It is offered anyway, with its
            end date shown, because before-and-after night lights across 2016–2023 is a real
            technique for observing a city losing power — but nothing after that date exists to
            show, and the tool refuses the date rather than displaying the nearest available day
            under the wrong label.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            The Kakhovka dam on the Dnipro failed on 6 June 2023, and the reservoir behind it
            drained over the following days. The change is far larger than 300 metres, which
            makes it exactly the kind of event this instrument can settle.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              The page opens centred on <code className="font-mono text-sm">46.75, 33.37</code>{" "}
              at zoom 8, which is the reservoir and the reach below the dam.
            </li>
            <li>
              The earlier view is set to <strong className="text-foreground">30 May 2023</strong>{" "}
              and the later one to <strong className="text-foreground">8 June 2023</strong>, both
              on MODIS Terra true colour.
            </li>
            <li>Load the imagery, then switch to swipe and drag the divider across the reservoir.</li>
          </ol>
          <p>
            The water body north-east of the dam is visibly smaller on the later date and the
            exposed bed is a different colour. That is a change of tens of kilometres in extent
            — well above the resolution floor — so it is a finding rather than an artefact.
          </p>
          <p>
            <strong className="text-foreground">Now do the work that makes it evidence.</strong>{" "}
            Step the later date forward one day at a time and watch the change continue: a
            single pair of dates can be two different cloud conditions, and a progression over
            several days cannot. Then switch the earlier side to a different platform — Aqua, or
            VIIRS — on the same date, and confirm the pre-event state looks the same through a
            second instrument. Two instruments agreeing on the before and a monotonic
            progression in the after is a much stronger claim than one swipe.
          </p>
          <p>
            Finally, note what you still cannot say. At this resolution you cannot see the dam
            structure, you cannot count breaches, and you cannot see anything about cause. State
            the finding as what the pixels support: the reservoir extent decreased sharply
            between two dates. The rest needs a different sensor.
          </p>
        </>
      }
    >
      <ImageryComparator />
    </ToolPage>
  );
}

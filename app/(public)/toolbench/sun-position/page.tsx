import { notFound } from "next/navigation";

import { SunTool } from "@/components/toolbench/sun-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("sun-position");

export const metadata = pageMetadata({
  title: "Sun position and shadow calculator",
  description:
    "Solar azimuth, elevation and shadow ratio for a place and time, and the inverse: which times of day could have cast the shadow visible in a photograph.",
  path: "/toolbench/sun-position",
});

export default function SunPositionPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            The sun&apos;s position for a given place and instant is arithmetic — a well-known
            series that has been in the literature since Meeus. Its elevation above the horizon
            fixes the length of the shadow a vertical object casts on level ground: the shadow
            is <code className="font-mono text-sm">1 / tan(elevation)</code> times the
            object&apos;s height. At 45&deg; the shadow equals the height; at 30&deg; it is 1.73
            times; at 10&deg; it is 5.7 times. Its azimuth fixes the direction: a shadow falls
            directly away from the sun.
          </p>
          <p>
            Run backwards, this becomes chronolocation. You measure a shadow and the object
            casting it in the image — pixels are fine, since only the ratio matters — and ask
            which times of day at the confirmed location would produce it. The tool scans the
            whole day and refines each crossing to the second.
          </p>
          <p>
            The answer is normally <strong className="text-foreground">two times</strong>, one
            climbing and one descending, symmetric about solar noon. That is not a limitation of
            the method; it is the geometry. Only the direction the shadow points separates them,
            which is why the tool takes an observed bearing and ranks the candidates against it.
            Establishing which way is north in a frame is usually the harder half of the work.
          </p>
          <p>
            Positions come from <code className="font-mono text-sm">suncalc</code>, whose
            altitudes are refraction-corrected — the right convention here, because a shadow
            follows where the sun appears to be rather than where it geometrically is.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">It gives you a time of day, never a
            date.</strong> The same solar elevation recurs on two dates each year, symmetric
            about the solstice, and near the equator the annual variation is so small that
            almost any date fits. Shadow work constrains a claimed time; it does not establish
            when a photograph was taken.
          </p>
          <p>
            <strong className="text-foreground">The measurement dominates the error, and it
            is usually worse than you think.</strong> A soft shadow tip, a shadow foreshortened
            because the camera is looking along it rather than across it, ground that slopes,
            or an object that is not vertical — any of these puts the ratio 15% out easily. At
            a low sun that is more than an hour. Measure across the shadow, not along it, and
            treat a single measurement as a range.
          </p>
          <p>
            <strong className="text-foreground">A match is weak evidence; a mismatch is
            stronger but not conclusive.</strong> If the shadows fit the claimed time you have
            failed to falsify one claim, which is not the same as confirming it — most times of
            day fit most shadows to within your measurement error. If they do not fit, the
            photograph may be mistimed, or your location may be wrong, or the ground may not be
            level. Work out which before reporting it.
          </p>
          <p>
            <strong className="text-foreground">&quot;Impossible&quot; is the strongest result
            this tool produces.</strong> When the required elevation exceeds the highest the sun
            reaches at that place on that date, no time of day fits and at least one of the
            date, the location and the measurement is wrong. That is a real finding, and it is
            the one worth chasing.
          </p>
          <p>
            <strong className="text-foreground">Accuracy of the model, for the record.</strong>{" "}
            The underlying algorithm is the low-precision solar series, good to roughly a
            minute of arc. That is far finer than anything you can measure off a photograph and
            not adequate for astronomy. Refraction is modelled; local horizon obstruction,
            terrain and elevation above sea level are not.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            A video is claimed to have been filmed in Greenwich, London, on the afternoon of 21
            June 2026. A lamp post in frame casts a shadow you measure at 1.4 times its height,
            and the shadow runs roughly east-north-east — you have established north from a
            building line you matched on satellite imagery.
          </p>
          <p>
            Enter the location, the date, an object height of 1 and a shadow length of 1.4. The
            tool reports that the ratio needs the sun{" "}
            <strong className="text-foreground">35.5&deg;</strong> above the horizon, and that
            this happens twice: at{" "}
            <strong className="text-foreground">07:54 UTC</strong>, with the shadow pointing
            276&deg; (west), and at{" "}
            <strong className="text-foreground">16:09 UTC</strong>, with the shadow pointing
            84&deg; (east).
          </p>
          <p>
            Your observed direction eliminates the morning candidate outright: at 07:54 the
            shadow would point west, and yours points east. So the afternoon reading stands —
            17:09 British Summer Time — and the claim of &quot;afternoon&quot; survives the
            test. Note what you have and have not shown: the lighting is consistent with the
            claim, which is weaker than the claim being true.
          </p>
          <p>
            Now suppose the shadow had measured 0.4 times the height. The tool refuses to give
            a time and says why: that ratio needs the sun 68&deg; up, and in London on the
            longest day of the year it reaches 62&deg;. No time of day fits, on that date, at
            that place. Either the location is wrong or the date is — and that is a
            substantially more useful result than a time.
          </p>
        </>
      }
    >
      <SunTool />
    </ToolPage>
  );
}

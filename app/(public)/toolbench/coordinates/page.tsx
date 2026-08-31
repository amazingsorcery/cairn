import Link from "next/link";
import { notFound } from "next/navigation";

import { CoordinateTool } from "@/components/toolbench/coordinate-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("coordinates");

export const metadata = pageMetadata({
  title: "Coordinate converter",
  description:
    "Convert between decimal degrees, DMS, degrees and decimal minutes, UTM, MGRS and Plus Codes, with a map preview and an honest account of the precision each notation carries.",
  path: "/toolbench/coordinates",
});

export default function CoordinatesPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            All six notations describe the same thing: a position on the WGS 84 ellipsoid. They
            differ in how they cut it up, and each was designed for a different job.
          </p>
          <p>
            <strong className="text-foreground">Angular notations</strong> — decimal degrees,
            degrees-minutes-seconds, and degrees with decimal minutes — are the same two angles
            written three ways. DMS is what maps and EXIF use; decimal minutes is what marine
            and aviation charts use; decimal degrees is what software uses.
          </p>
          <p>
            <strong className="text-foreground">UTM</strong> projects the ellipsoid onto sixty
            six-degree strips and gives you metres east and north within one. Distances inside a
            zone are ordinary metres, which is why it is the notation of choice when you need to
            measure something. The conversion here uses the series from Snyder&apos;s{" "}
            <em>Map Projections — A Working Manual</em> (USGS Professional Paper 1395),
            reproduced to within a decimetre of that document&apos;s own worked example.
          </p>
          <p>
            <strong className="text-foreground">MGRS</strong> is UTM with the leading digits
            replaced by two letters naming a 100 km square. Its virtue is that precision is
            visible in the length: four digits per axis is 10 m, five is 1 m. A grid reference
            cannot silently overstate how precisely it was measured, which decimal degrees does
            constantly.
          </p>
          <p>
            <strong className="text-foreground">Plus Codes</strong> (Open Location Code) encode
            latitude and longitude into one base-20 string over an alphabet with no vowels, so
            a code cannot accidentally spell a word and is hard to mistranscribe. Eight
            characters is about 275 m, ten is about 14 m, eleven about 3 m.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">A conversion adds no accuracy.</strong> If you
            read a coordinate off a photograph to the nearest hundred metres, its eleven-digit
            Plus Code is precise to three metres and accurate to a hundred. The tool renders
            precision; only the source can supply accuracy. Quote fewer digits.
          </p>
          <p>
            <strong className="text-foreground">A grid reference without its zone, band or
            datum is ambiguous, sometimes catastrophically.</strong> The letter in{" "}
            <code className="font-mono text-sm">33S</code> is a latitude <em>band</em> covering
            32&deg;N to 40&deg;N — Ankara and Oklahoma are both in it. Somebody writing
            &quot;33S&quot; to mean &quot;zone 33, southern hemisphere&quot; is about 7,500 km
            from where they meant, and the notation gives no way to tell the two readings
            apart. This tool takes the letter at its documented meaning.
          </p>
          <p>
            <strong className="text-foreground">Everything here assumes WGS 84.</strong> The
            same ground point differs by a few hundred metres between WGS 84 and a mid-century
            national datum, and by roughly 500 m in the shifted grid used for public mapping in
            mainland China. A coordinate from an old map, or from a Chinese consumer mapping
            service, is not a WGS 84 coordinate and converting it here will produce a confident
            wrong answer.
          </p>
          <p>
            <strong className="text-foreground">Grid north is not true north.</strong> A bearing
            read off a UTM or MGRS grid differs from a true bearing by the convergence angle,
            up to about three degrees at a zone edge. The tool reports it; subtract it before
            comparing a map bearing against a sun azimuth.
          </p>
          <p>
            <strong className="text-foreground">what3words is not included, and cannot
            be.</strong> Its wordlist is proprietary and not licensed for reimplementation.
            Offering it would mean sending your coordinate to their servers, which is exactly
            the disclosure this workbench exists to avoid — so the tool says so rather than
            pretending. Plus Codes are the open equivalent and are implemented in full.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            A police report gives an incident location as{" "}
            <code className="font-mono text-sm">30U YC 08210 07238</code>. A witness photograph
            you are working from was geotagged{" "}
            <code className="font-mono text-sm">51&deg;28&apos;40.54&quot;N
            000&deg;00&apos;05.56&quot;W</code>. A local account posted a Plus Code,{" "}
            <code className="font-mono text-sm">9C3XFXHX+59</code>.
          </p>
          <p>
            Paste each in turn. All three resolve to{" "}
            <code className="font-mono text-sm">51.477928, -0.001545</code> — the Royal
            Observatory at Greenwich — so the three sources agree, which is a finding you could
            not have reached by looking at the three strings.
          </p>
          <p>
            Now note what the notations were each claiming. The MGRS reference is quoted to
            five digits per axis, which asserts one-metre precision. The Plus Code at ten
            digits asserts about fourteen metres. If the police report was actually derived
            from a street address, that one-metre claim is spurious precision introduced by
            whoever converted it, and it should not survive into your copy. Re-quote the MGRS
            at three digits per axis — a 100 m box — and you have a figure that matches what
            the source actually knew.
          </p>
          <p>
            Open the map preview only if you need it. Doing so requests tiles from
            OpenStreetMap, which tells a third party which coordinate you are looking at; the
            conversion itself tells nobody anything. The same discipline is why the{" "}
            <Link
              href="/toolbench/image-metadata"
              className="font-medium text-primary underline underline-offset-4"
            >
              metadata inspector
            </Link>{" "}
            reads a source&apos;s photograph in your own browser.
          </p>
        </>
      }
    >
      <CoordinateTool />
    </ToolPage>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";

import { ImageMetadataTool } from "@/components/toolbench/image-metadata-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("image-metadata");

export const metadata = pageMetadata({
  title: "Image metadata inspector",
  description:
    "Read EXIF, IPTC and XMP out of an image in your own browser, plot any GPS fix, and compare the embedded thumbnail against the picture it claims to preview.",
  path: "/toolbench/image-metadata",
});

export default function ImageMetadataPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            A camera writes structured data into the file alongside the picture: make and model,
            lens, exposure, orientation, timestamps, sometimes a GPS fix, and a small JPEG
            preview of the image. Editors add their own — a software string, an XMP block that
            may carry an edit history. This tool reads every block it finds and shows them
            separately rather than merged, because which block a value came from, and whether
            two blocks disagree about the same thing, is often the most useful signal in the
            file.
          </p>
          <p>
            <strong className="text-foreground">The thumbnail comparison</strong> is the part
            that does independent work. The embedded preview is a picture of what the file
            looked like when that preview was written. Most editors regenerate it; some, and
            several careless workflows, do not. When they do not, the preview and the visible
            image disagree, and the difference between them is the edit. The tool measures that
            two ways — a perceptual difference hash, which ignores brightness and scale, and a
            mean brightness difference, which does not — and shows you both images side by
            side, because the numbers are a pointer and your eyes are the instrument.
          </p>
          <p>
            All of it runs in this browser tab. The file is read with{" "}
            <code className="font-mono text-sm">File.arrayBuffer</code> and decoded on a canvas;
            there is no upload endpoint in this application for it to go to. That constraint is
            the reason the playbook can tell you to run this on a source&apos;s photograph
            rather than pasting it into a metadata website.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">Metadata is a claim, not a fact.</strong> Every
            field here can be rewritten in seconds with freely available tools, and a
            suspiciously helpful one — a precise GPS fix and timestamp on a file that is
            otherwise bare — is a reason for more suspicion rather than less. Treat a GPS tag
            as a hypothesis to confirm against what is visible in the picture.
          </p>
          <p>
            <strong className="text-foreground">Absence proves almost nothing.</strong> Every
            major platform strips metadata on upload. A file with no EXIF has overwhelmingly
            likely been through one, not been deliberately cleaned. The correct response is to
            ask the source for the file straight off the device, not to conclude anything.
          </p>
          <p>
            <strong className="text-foreground">A clean thumbnail comparison is not a clean
            file.</strong> Any editor that regenerates the preview leaves the two in agreement
            no matter what was done to the picture — and most of them do. A match is equally
            consistent with no editing and with editing by any ordinary tool. Only the
            mismatch carries information.
          </p>
          <p>
            <strong className="text-foreground">A mismatch is not proof of manipulation
            either.</strong> A crop, a rotation, an auto-enhance in a phone&apos;s gallery, or
            a legitimate colour correction all produce one. It tells you where to look, not
            what happened.
          </p>
          <p>
            <strong className="text-foreground">A camera clock is only as good as whoever set
            it.</strong> EXIF timestamps carry no time zone unless the camera also wrote{" "}
            <code className="font-mono text-sm">OffsetTimeOriginal</code>, which most do not.
            Unset clocks and drift are ordinary.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            A source sends you a photograph they say they took at a protest that morning. Hash
            it first in the{" "}
            <Link
              href="/toolbench/hashes-and-encodings"
              className="font-medium text-primary underline underline-offset-4"
            >
              hash workbench
            </Link>{" "}
            and record the digest, then open it here.
          </p>
          <p>
            Suppose the file reports a device, a{" "}
            <code className="font-mono text-sm">DateTimeOriginal</code> that afternoon, a{" "}
            <code className="font-mono text-sm">ModifyDate</code> four hours later, and a{" "}
            <code className="font-mono text-sm">Software</code> string naming an image editor.
            None of that is damning: people crop photographs before sending them. What it tells
            you is that the file you are holding is not the camera original, so ask for the
            original — and note that the four-hour gap is the interval to ask about, not the
            existence of a gap.
          </p>
          <p>
            The GPS block gives a fix. Convert it in the{" "}
            <Link
              href="/toolbench/coordinates"
              className="font-medium text-primary underline underline-offset-4"
            >
              coordinate converter
            </Link>{" "}
            and check it against what is visible in the frame; if the picture shows a building
            that is not at that coordinate, the tag is wrong or forged and you have learnt
            something either way. If the file also carries a camera bearing, that constrains
            what should be in shot — a check you can run against satellite imagery without
            leaving your desk.
          </p>
          <p>
            Then take the capture time to the{" "}
            <Link
              href="/toolbench/sun-position"
              className="font-medium text-primary underline underline-offset-4"
            >
              sun position tool
            </Link>{" "}
            with the shadows in the picture. Metadata says when the camera thought it was;
            shadows say what the sky was doing. When they agree you have two independent
            sources; when they disagree you have a question worth asking.
          </p>
        </>
      }
    >
      <ImageMetadataTool />
    </ToolPage>
  );
}

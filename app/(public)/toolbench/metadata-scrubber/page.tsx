import Link from "next/link";
import { notFound } from "next/navigation";

import { MetadataScrubberTool } from "@/components/toolbench/metadata-scrubber-tool";
import { ToolPage } from "@/components/toolbench/tool-page";
import { pageMetadata } from "@/lib/metadata";
import { findTool } from "@/lib/toolbench/registry";

const entry = findTool("metadata-scrubber");

export const metadata = pageMetadata({
  title: "Metadata scrubber",
  description:
    "Strip EXIF, XMP, IPTC and comments out of a JPEG or PNG in your own browser, without re-encoding a single pixel.",
  path: "/toolbench/metadata-scrubber",
});

export default function MetadataScrubberPage() {
  if (entry === null) notFound();

  return (
    <ToolPage
      entry={entry}
      technique={
        <>
          <p>
            A JPEG is a sequence of marker segments and a PNG is a sequence of chunks. In both
            formats the metadata lives in segments that sit next to the compressed image data
            rather than inside it, so it can be removed by rewriting the container and copying
            the picture through byte for byte. That is what this tool does: the file you
            download decodes to exactly the same pixels as the one you put in.
          </p>
          <p>
            The usual browser approach — draw the image onto a canvas and export it — also
            removes metadata, and re-compresses every pixel while doing it. The picture you
            publish is then not the picture you were given: it looks slightly different, it is
            a different size, and it can no longer be compared against the original. For a
            newsroom that is a real loss, so this tool does not do it, and refuses formats
            where it would have to.
          </p>
          <p>
            <strong className="text-foreground">Three things are deliberately kept</strong>,
            because removing them changes what the file looks like: the JFIF density header, the
            ICC colour profile (strip it and a wide-gamut photograph renders as if it were
            sRGB — visibly wrong colour in a file the reader believes is unmodified), and the
            Adobe colour-transform marker (without it a CMYK JPEG decodes inverted). The tool
            lists what it kept and why, so the result is never silently partial.
          </p>
          <p>
            Two SHA-256 digests come back with the result, because a scrubbed file is a
            different file. If the original is in your chain of custody, the published one
            needs its own entry, and the pair of digests is what connects them.
          </p>
        </>
      }
      limits={
        <>
          <p>
            <strong className="text-foreground">This is not redaction.</strong> Everything
            visible in the picture is still visible: a street sign, a house number, a
            reflection in a window, a screen, a document on a desk, a face. Metadata scrubbing
            narrows one channel of disclosure and leaves the largest one completely untouched.
            If the picture itself identifies someone, you need to change the picture.
          </p>
          <p>
            <strong className="text-foreground">Sensor and encoder fingerprints
            survive.</strong> Photo-response non-uniformity is a property of the pixels, and
            quantisation and Huffman tables identify the software that encoded the file. Both
            are the image, so both remain. Against an adversary doing forensic work, stripping
            EXIF is not anonymity.
          </p>
          <p>
            <strong className="text-foreground">Nothing here protects you from the platform
            you upload to.</strong> It sees your account, your address, the time, and often
            more from the upload itself than the file ever contained. Several platforms also
            add their own identifiers to what they serve back.
          </p>
          <p>
            <strong className="text-foreground">JPEG and PNG only.</strong> Other formats —
            HEIC, WebP, TIFF, video — would have to be re-encoded to strip losslessly with the
            tools available in a browser, and a re-encoded file is not the same file. The tool
            declines rather than doing it quietly.
          </p>
          <p>
            <strong className="text-foreground">Check the result.</strong> Run the scrubbed
            file back through the{" "}
            <Link
              href="/toolbench/image-metadata"
              className="font-medium text-primary underline underline-offset-4"
            >
              metadata inspector
            </Link>{" "}
            before publishing. Verifying is one click and assuming is how a location gets
            published.
          </p>
        </>
      }
      workedExample={
        <>
          <p>
            A source in a country where being identified would put them at risk sends you a
            photograph of a document. You want to publish the photograph.
          </p>
          <p>
            Inspect it first, so you know what you are removing: the file carries the phone
            model, a capture timestamp, and a GPS fix on a residential street. Publishing it
            unchanged would tell any reader with a metadata viewer roughly where your source
            lives.
          </p>
          <p>
            Run it through this tool. It reports removing the APP1 EXIF block and an XMP block,
            about 40 kB in total, and keeping the JFIF header and the ICC profile. Download the
            result and open it in the inspector again: the EXIF is gone, the picture is
            unchanged, and the two SHA-256 digests differ — which is expected, and which is why
            both of them go in your notes.
          </p>
          <p>
            Then look at the picture properly. If the document has a reference number, a
            letterhead, a handwritten note in a recognisable hand, or a corner of a window
            showing a street, none of that was touched and none of it should be published
            without a decision. The scrubber did its job; the harder half is not its job.
          </p>
        </>
      }
    >
      <MetadataScrubberTool />
    </ToolPage>
  );
}

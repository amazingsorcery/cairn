"use client";

import * as React from "react";
import exifr from "exifr";
import { Info, Sparkles } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { renderAllFormats } from "@/lib/toolbench/coordinates";
import {
  analyseMetadata,
  extractGps,
  normaliseMetadata,
  type GpsFix,
  type MetadataBlock,
  type MetadataFinding,
} from "@/lib/toolbench/exif";
import { IMAGE_GATE, checkFileSize, checkFileType, formatBytes } from "@/lib/toolbench/files";
import {
  compareThumbnailToImage,
  type ThumbnailComparison,
} from "@/lib/toolbench/image-compare";
import { Announcer, useAnnounce } from "./announcer";
import { MapPreview } from "./map-preview";
import { FieldError, OutputRow, ToolPanel } from "./output-row";

/**
 * The metadata inspector.
 *
 * `exifr` parses in this tab and the canvas work happens in this tab. There is no upload
 * endpoint in this application for an image to go to, which is the whole reason the playbook
 * can tell a reader to run this on a source's photograph: the alternative advice is "paste it
 * into a metadata website", and that hands a source's file to a stranger.
 */

const MAX_DECODE_PIXELS = 40_000_000;

interface Analysis {
  readonly fileName: string;
  readonly fileSize: number;
  readonly typeLabel: string;
  readonly blocks: readonly MetadataBlock[];
  readonly gps: GpsFix | null;
  readonly findings: readonly MetadataFinding[];
  readonly comparison: ThumbnailComparison | null;
  readonly thumbnailUrl: string | null;
  readonly imageUrl: string | null;
  readonly thumbnailNote: string;
}

/** Decode a blob into pixels, at a bounded size, entirely in the browser. */
async function samplePixels(
  blob: Blob,
): Promise<{ pixels: Uint8ClampedArray; width: number; height: number } | null> {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement | null>((resolve) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => resolve(null);
      element.src = url;
    });
    if (image === null || image.naturalWidth === 0) return null;
    if (image.naturalWidth * image.naturalHeight > MAX_DECODE_PIXELS) return null;

    // 64 x 64 is more than either measure needs and keeps the work trivial even for a
    // 50-megapixel original.
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context === null) return null;
    context.drawImage(image, 0, 0, size, size);
    const data = context.getImageData(0, 0, size, size);
    return { pixels: data.data, width: size, height: size };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Natural dimensions, needed for the aspect-ratio half of the comparison. */
async function naturalSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ width: number; height: number } | null>((resolve) => {
      const element = new Image();
      element.onload = () => resolve({ width: element.naturalWidth, height: element.naturalHeight });
      element.onerror = () => resolve(null);
      element.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function FindingList({ findings }: { findings: readonly MetadataFinding[] }) {
  return (
    <ul className="space-y-3">
      {findings.map((finding) => (
        <li key={finding.title} className="flex gap-3">
          {finding.severity === "notable" ? (
            <Sparkles className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <div>
            <p className="text-sm font-medium text-foreground">
              {finding.title}
              <span className="sr-only">
                {finding.severity === "notable" ? " — worth following up" : " — background"}
              </span>
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-foreground-secondary">
              {finding.detail}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ImageMetadataTool() {
  return (
    <Announcer>
      <ImageMetadataToolInner />
    </Announcer>
  );
}

function ImageMetadataToolInner() {
  const announce = useAnnounce();
  const [analysis, setAnalysis] = React.useState<Analysis | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const objectUrls = React.useRef<string[]>([]);

  const releaseUrls = React.useCallback(() => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current = [];
  }, []);

  React.useEffect(() => releaseUrls, [releaseUrls]);

  const inspect = React.useCallback(
    async (file: File) => {
      setError(null);
      const size = checkFileSize(file.size, IMAGE_GATE);
      if (!size.ok) {
        setError(size.error);
        return;
      }
      setBusy(true);
      releaseUrls();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const type = checkFileType(bytes, IMAGE_GATE);
        if (!type.ok) {
          setError(type.error);
          setAnalysis(null);
          return;
        }

        // `mergeOutput: false` keeps the segments apart. Merging is convenient and destroys
        // the most useful signal in the file — which block a value came from, and whether
        // two blocks disagree.
        const raw: unknown = await exifr.parse(bytes, {
          // `ifd0` is typed as options-only because it cannot be switched off; passing
          // `true` is a type error rather than a no-op, so it is simply omitted.
          tiff: true,
          exif: true,
          gps: true,
          interop: true,
          iptc: true,
          xmp: true,
          icc: true,
          jfif: true,
          ihdr: true,
          mergeOutput: false,
          translateKeys: true,
          translateValues: true,
          reviveValues: true,
        });

        const blocks = normaliseMetadata(raw);
        const gps = extractGps(raw);
        const findings = analyseMetadata(blocks, gps);

        let comparison: ThumbnailComparison | null = null;
        let thumbnailUrl: string | null = null;
        let thumbnailNote =
          "No embedded thumbnail. That is the usual state of an image that has been through a platform, and it means this check cannot be run — not that the file is clean.";

        const thumbnailBytes: unknown = await exifr.thumbnail(bytes).catch(() => null);
        if (thumbnailBytes instanceof Uint8Array && thumbnailBytes.length > 0) {
          const thumbnailBlob = new Blob([thumbnailBytes.slice()], { type: "image/jpeg" });
          const [thumbSample, fullSample, thumbSize, fullSize] = await Promise.all([
            samplePixels(thumbnailBlob),
            samplePixels(file),
            naturalSize(thumbnailBlob),
            naturalSize(file),
          ]);
          if (thumbSample && fullSample && thumbSize && fullSize) {
            comparison = compareThumbnailToImage(
              { pixels: thumbSample.pixels, width: thumbSize.width, height: thumbSize.height },
              { pixels: fullSample.pixels, width: fullSize.width, height: fullSize.height },
            );
            // The samples are square, so the hash and the mean difference are computed on
            // the squashed versions; the aspect ratio is measured from the true dimensions.
            comparison = {
              ...comparison,
              aspectRatioDifference: Math.abs(
                thumbSize.width / thumbSize.height - fullSize.width / fullSize.height,
              ),
            };
            thumbnailNote = comparison.reading;
            thumbnailUrl = URL.createObjectURL(thumbnailBlob);
            objectUrls.current.push(thumbnailUrl);
          } else {
            thumbnailNote =
              "An embedded thumbnail is present but one of the two images could not be decoded in this browser, so they could not be compared.";
          }
        }

        const imageUrl = URL.createObjectURL(file);
        objectUrls.current.push(imageUrl);

        setAnalysis({
          fileName: file.name,
          fileSize: file.size,
          typeLabel: type.value.label,
          blocks,
          gps,
          findings,
          comparison,
          thumbnailUrl,
          imageUrl,
          thumbnailNote,
        });
        announce(
          `${file.name} read. ${blocks.length} metadata blocks, ${findings.length} points to look at${gps === null ? ", no GPS fix" : ", including a GPS fix"}.`,
        );
      } catch {
        setError(
          "That file could not be read as an image. If it came from a messaging app, try exporting it again rather than screenshotting it.",
        );
        setAnalysis(null);
      } finally {
        setBusy(false);
      }
    },
    [announce, releaseUrls],
  );

  const gpsRendering =
    analysis?.gps != null ? renderAllFormats(analysis.gps.latitude, analysis.gps.longitude) : null;

  return (
    <div className="space-y-5">
      <ToolPanel
        title="Image"
        description="Read in this browser tab. There is no upload — this application has no endpoint that would accept one."
      >
        <Label htmlFor="metadata-file">Choose an image</Label>
        <Input
          id="metadata-file"
          type="file"
          accept="image/*"
          className="mt-1.5 h-11 py-2 file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void inspect(file);
          }}
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          JPEG, PNG, WebP, TIFF, HEIC or AVIF, up to {formatBytes(IMAGE_GATE.maxBytes)}. The
          format is checked from the file&apos;s own leading bytes, not from its name.
        </p>
        {error !== null ? <FieldError>{error}</FieldError> : null}
        {busy ? (
          <p className="mt-3 text-sm text-muted-foreground">Reading…</p>
        ) : null}
      </ToolPanel>

      {analysis !== null ? (
        <>
          <ToolPanel
            title="What to look at first"
            description={`${analysis.fileName} — ${analysis.typeLabel}, ${formatBytes(analysis.fileSize)}`}
          >
            <FindingList findings={analysis.findings} />
          </ToolPanel>

          {analysis.gps !== null && gpsRendering !== null ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <ToolPanel
                title="GPS fix"
                description="A claim the file makes about where it was taken. Confirm it against the picture before relying on it."
              >
                <div>
                  <OutputRow label="Decimal degrees" value={gpsRendering.decimalDegrees} />
                  <OutputRow label="Degrees, minutes, seconds" value={gpsRendering.degreesMinutesSeconds} />
                  <OutputRow
                    label="MGRS"
                    value={gpsRendering.mgrs ?? gpsRendering.mgrsError ?? "unavailable"}
                    tone={gpsRendering.mgrs === null ? "muted" : "default"}
                  />
                  <OutputRow
                    label="Altitude"
                    value={
                      analysis.gps.altitudeMetres === null
                        ? "not recorded"
                        : `${analysis.gps.altitudeMetres.toFixed(1)} m`
                    }
                    tone={analysis.gps.altitudeMetres === null ? "muted" : "default"}
                    copyLabel="the altitude"
                  />
                  <OutputRow
                    label="Camera bearing"
                    value={
                      analysis.gps.imageDirectionDegrees === null
                        ? "not recorded"
                        : `${analysis.gps.imageDirectionDegrees.toFixed(1)}° ${analysis.gps.directionReference === "M" ? "magnetic" : "true"}`
                    }
                    tone={analysis.gps.imageDirectionDegrees === null ? "muted" : "default"}
                    copyLabel="the camera bearing"
                  />
                </div>
              </ToolPanel>
              <MapPreview
                latitude={analysis.gps.latitude}
                longitude={analysis.gps.longitude}
                label={`the GPS fix in ${analysis.fileName}`}
              />
            </div>
          ) : null}

          <ToolPanel
            title="Embedded thumbnail against the image"
            description="A camera writes a small preview into the file. When an edit changes the picture but not the preview, the preview is a photograph of what the file used to look like."
          >
            <p className="text-sm leading-relaxed text-foreground-secondary">
              {analysis.thumbnailNote}
            </p>
            {analysis.comparison !== null ? (
              <div className="mt-4">
                <OutputRow
                  label="Perceptual difference"
                  value={`${analysis.comparison.hammingDistance} of 64 bits`}
                  hint="under 10 is conventionally the same picture"
                  copyLabel="the perceptual difference"
                />
                <OutputRow
                  label="Mean brightness difference"
                  value={analysis.comparison.meanAbsoluteDifference.toFixed(1)}
                  hint="0 to 255"
                  copyLabel="the brightness difference"
                />
                <OutputRow
                  label="Aspect ratio difference"
                  value={analysis.comparison.aspectRatioDifference.toFixed(4)}
                  copyLabel="the aspect ratio difference"
                  note="Anything beyond rounding here means the preview and the image are not the same shape, which a crop or a rotation produces."
                />
              </div>
            ) : null}
            {analysis.thumbnailUrl !== null && analysis.imageUrl !== null ? (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from
                      the reader's own file. next/image would route it through the optimiser,
                      which is a server round trip this tool exists to avoid. */}
                  <img
                    src={analysis.thumbnailUrl}
                    alt="The thumbnail embedded in the file's metadata"
                    className="w-full rounded-md border border-border bg-muted object-contain"
                  />
                  <figcaption className="mt-1.5 text-xs text-muted-foreground">
                    Embedded thumbnail
                  </figcaption>
                </figure>
                <figure>
                  {/* eslint-disable-next-line @next/next/no-img-element -- as above. */}
                  <img
                    src={analysis.imageUrl}
                    alt="The image itself, for comparison against its embedded thumbnail"
                    className="w-full rounded-md border border-border bg-muted object-contain"
                  />
                  <figcaption className="mt-1.5 text-xs text-muted-foreground">The image</figcaption>
                </figure>
              </div>
            ) : null}
          </ToolPanel>

          {analysis.blocks.length > 0 ? (
            <ToolPanel
              title="Every field, as written"
              description="Grouped by the block each value came from. Where two blocks state the same thing differently, the disagreement is the finding."
            >
              <Accordion type="multiple" className="w-full">
                {analysis.blocks.map((block) => (
                  <AccordionItem key={block.id} value={block.id}>
                    <AccordionTrigger>
                      {block.label}
                      <span className="ml-auto mr-2 text-xs font-normal text-muted-foreground">
                        {block.entries.length} fields
                      </span>
                    </AccordionTrigger>
                    <AccordionContent>
                      <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
                        {block.description}
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <caption className="sr-only">{block.label} fields</caption>
                          <thead>
                            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                              <th scope="col" className="py-2 pr-4 font-medium">
                                Field
                              </th>
                              <th scope="col" className="py-2 font-medium">
                                Value
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {block.entries.map((entry) => (
                              <tr key={entry.key} className="border-b border-border last:border-b-0">
                                <th scope="row" className="py-2 pr-4 text-left align-top font-normal">
                                  {entry.key}
                                </th>
                                <td className="break-all py-2 font-mono text-xs">
                                  {entry.value}
                                  {entry.summarised ? (
                                    <span className="ml-1 text-muted-foreground">(shortened)</span>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </ToolPanel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

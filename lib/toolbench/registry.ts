/**
 * The Toolbench index.
 *
 * One entry per route that exists and resolves. Product-brief section 8: if it is not built,
 * it is not linked — so a tool is added here in the same change that adds its page, never
 * before, and there is no "coming soon" state.
 *
 * `dataHandling` is the field that matters most to this audience and it is not decoration:
 * it is rendered as a badge on the index and again at the top of each tool page, and it must
 * describe what the tool actually does rather than what we would like it to do.
 */

export type DataHandling = "inBrowser" | "opensThirdParty";

export const DATA_HANDLING_LABEL: Readonly<Record<DataHandling, string>> = {
  inBrowser: "Runs in your browser",
  opensThirdParty: "Sends your image to a third party",
};

export const DATA_HANDLING_DETAIL: Readonly<Record<DataHandling, string>> = {
  inBrowser:
    "Everything this tool does happens on your own machine. No file, no coordinate and no text you type is sent to this site's server or anywhere else — there is no request to send it in.",
  opensThirdParty:
    "This tool opens other companies' search engines. Nothing is uploaded to this site, but the image does reach whichever engines you open, and they keep their own records of it.",
};

export interface ToolbenchEntry {
  readonly slug: string;
  readonly name: string;
  /** One line, on the index card. */
  readonly summary: string;
  readonly dataHandling: DataHandling;
  /** The playbook this tool is a step in. Every entry has one; a tool with no method is a toy. */
  readonly playbook: { readonly slug: string; readonly title: string; readonly step: string };
  /** Grouping on the index page. */
  readonly group: ToolGroup;
}

export type ToolGroup = "encodings" | "time" | "place" | "images";

export const TOOL_GROUPS: readonly { readonly id: ToolGroup; readonly label: string; readonly blurb: string }[] = [
  {
    id: "encodings",
    label: "Encodings and hashes",
    blurb:
      "Reading the machine-readable material an investigation throws off: digests for a chain of custody, and the encodings that obfuscated data hides behind.",
  },
  {
    id: "time",
    label: "Time",
    blurb:
      "Putting events on one timeline when the sources count from four different zeroes and half of them record no zone at all.",
  },
  {
    id: "place",
    label: "Place",
    blurb:
      "Coordinates in the notations sources actually use, and the solar geometry that turns a shadow into a clock.",
  },
  {
    id: "images",
    label: "Images",
    blurb:
      "What a picture carries besides the picture — and how to take it back out before publishing.",
  },
];

export const TOOLBENCH_ENTRIES: readonly ToolbenchEntry[] = [
  {
    slug: "hashes-and-encodings",
    name: "Hash and encoding workbench",
    summary:
      "SHA-1 through SHA-512 and MD5 over text or a file, base64, base32 and hex, URL encoding, JWT decoding, ROT-n and XOR.",
    dataHandling: "inBrowser",
    group: "encodings",
    playbook: {
      slug: "verifying-a-photos-origin",
      title: "Verifying a photo's origin",
      step: "Step 1 asks you to hash the file the moment you receive it and write the digest into your notes with the date and time. That is the anchor everything later in the playbook is compared against.",
    },
  },
  {
    slug: "timestamps",
    name: "Timestamp and time-zone converter",
    summary:
      "Unix seconds and milliseconds, ISO 8601, Windows FILETIME, WebKit, Mac absolute time, HFS+ and MS-DOS packed values, across any IANA time zone.",
    dataHandling: "inBrowser",
    group: "time",
    playbook: {
      slug: "verifying-a-viral-videos-authenticity-and-timeline",
      title: "Verifying a viral video's authenticity and timeline",
      step: 'Step 4 insists on an exact publication timestamp from the platform rather than the interface\'s "2 years ago". This is where the value you extract gets turned into an instant you can put on a timeline next to everything else.',
    },
  },
  {
    slug: "coordinates",
    name: "Coordinate converter",
    summary:
      "Decimal degrees, DMS, DDM, UTM, MGRS and Plus Codes, converted between each other with a map preview and the precision each notation actually carries.",
    dataHandling: "inBrowser",
    group: "place",
    playbook: {
      slug: "geolocating-from-imagery",
      title: "Geolocating from imagery",
      step: "The whole playbook ends in a coordinate, and the sources along the way quote them in different notations — a military grid reference from one, a Plus Code from another, decimal degrees from OpenStreetMap. This is where they become the same point.",
    },
  },
  {
    slug: "sun-position",
    name: "Sun position and shadow calculator",
    summary:
      "Solar azimuth, elevation and shadow ratio for a place and time — and the inverse: which times of day could have produced the shadow you can see.",
    dataHandling: "inBrowser",
    group: "place",
    playbook: {
      slug: "geolocating-from-imagery",
      title: "Geolocating from imagery",
      step: "Step 7 tests whether the lighting in the image is consistent with the claimed date and time at the location you have confirmed. Shadows become a clock once the place is fixed, and this is the tool that reads it.",
    },
  },
  {
    slug: "image-metadata",
    name: "Image metadata inspector",
    summary:
      "EXIF, IPTC and XMP read out in full, any GPS fix plotted on a map, and the embedded thumbnail compared against the picture it claims to preview.",
    dataHandling: "inBrowser",
    group: "images",
    playbook: {
      slug: "verifying-a-photos-origin",
      title: "Verifying a photo's origin",
      step: "Step 2 extracts the embedded capture information without disclosing the image to a third party. That constraint is why this tool exists here rather than as a link to an upload site.",
    },
  },
  {
    slug: "metadata-scrubber",
    name: "Metadata scrubber",
    summary:
      "Strip EXIF, XMP, IPTC and comments out of a JPEG or PNG before publishing, without re-encoding a single pixel.",
    dataHandling: "inBrowser",
    group: "images",
    playbook: {
      slug: "verifying-a-photos-origin",
      title: "Verifying a photo's origin",
      step: "The inverse of step 2. Every field that playbook teaches you to read out of somebody else's photograph is a field in yours, and the moment you publish a source's image you are publishing their camera, their timestamps and possibly their location.",
    },
  },
  {
    slug: "reverse-image-search",
    name: "Reverse image search launcher",
    summary:
      "Open Google Lens, Yandex, Bing and TinEye against the same image in one action, with what each is good at and what their silence means.",
    dataHandling: "opensThirdParty",
    group: "images",
    playbook: {
      slug: "geolocating-from-imagery",
      title: "Geolocating from imagery",
      step: "Step 3 runs reverse image search before any manual work, because if somebody has already published this location the search costs two minutes and the manual work costs two days.",
    },
  },
];

export function findTool(slug: string): ToolbenchEntry | null {
  return TOOLBENCH_ENTRIES.find((entry) => entry.slug === slug) ?? null;
}

export function toolsInGroup(group: ToolGroup): readonly ToolbenchEntry[] {
  return TOOLBENCH_ENTRIES.filter((entry) => entry.group === group);
}

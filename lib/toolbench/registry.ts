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

export type DataHandling =
  | "inBrowser"
  | "opensThirdParty"
  | "onOurServer"
  | "viaOurServer"
  | "clientToSource";

export const DATA_HANDLING_LABEL: Readonly<Record<DataHandling, string>> = {
  inBrowser: "Runs in your browser",
  opensThirdParty: "Sends your image to a third party",
  onOurServer: "Queries a public source from our server",
  viaOurServer: "Searches a public source from our server",
  clientToSource: "Your browser loads media from the source",
};

export const DATA_HANDLING_DETAIL: Readonly<Record<DataHandling, string>> = {
  inBrowser:
    "Everything this tool does happens on your own machine. No file, no coordinate and no text you type is sent to this site's server or anywhere else — there is no request to send it in.",
  opensThirdParty:
    "This tool opens other companies' search engines. Nothing is uploaded to this site, but the image does reach whichever engines you open, and they keep their own records of it.",
  /**
   * The honest version, written for somebody deciding whether to type a sensitive domain
   * into it. It states what we see, what the upstream sees, and what we keep — including
   * the part that is genuinely protective, which is that the query never appears in a log.
   */
  onOurServer:
    "This tool cannot run in your browser: it queries a public source that a web page is not allowed to call directly. Your query goes to this site's server, which asks the source on your behalf and sends you the answer. That means the source sees our server rather than your address — but it does see what you asked about. We record that a lookup happened and how it ended; we never record the domain, address or URL you asked about, and there is no column in our audit log that could hold it.",
  /**
   * Distinct from `onOurServer`: these sources CAN be called from a browser, and we route
   * them through the server anyway. Saying "cannot" where we mean "chose not to" would
   * misdescribe the trade, and the trade is the thing the reader is deciding about.
   */
  viaOurServer:
    "Your browser could call this source directly. We route it through this site's server instead, so the source sees us rather than your address and never learns which place, language or area you were searching for — that pattern is the thing this audience most needs not to leak. The request is sent as a POST so the query does not appear in a web-server log, here or anywhere. We record that a search happened and how it ended, never what it asked for.",
  clientToSource:
    "This tool loads media straight from its source into your browser, because relaying it through us would turn a linking site into a rebroadcasting one and exhaust a small server in hours. Nothing about that media passes through this site. The consequence, which is the part that matters to you: the source sees your address and exactly what you requested, so consider that before loading imagery of, or listening to, something sensitive.",
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

export type ToolGroup = "encodings" | "time" | "place" | "images" | "network" | "signals";

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
  {
    id: "network",
    label: "Domains and networks",
    blurb:
      "The passive infrastructure surface behind a name: the hostnames its certificates have published, what it resolves to, who announces the address, and what the page used to say. These four query public sources from our server rather than from your browser, and each page says exactly what that means.",
  },
  {
    id: "signals",
    label: "Open transmissions",
    blurb:
      "What aircraft, ships and broadcasters put on the air, and what it does and does not tell you. An identifier broadcast in the clear is a claim by whoever configured the transmitter; a live stream is a source the publisher of a story does not control.",
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
  {
    slug: "certificate-transparency",
    name: "Certificate transparency search",
    summary:
      "Every hostname that has appeared in a publicly logged certificate for a domain, with the date each one was first certificated and which authority issued it.",
    dataHandling: "onOurServer",
    group: "network",
    playbook: {
      slug: "investigating-a-domain-and-its-infrastructure",
      title: "Investigating a domain and its infrastructure",
      step: "Step 3 enumerates the DNS and certificate surface, and it starts with certificate transparency because the logs are append-only: a hostname that appeared in a certificate in 2019 is still there whether or not it ever resolved, and its first-seen date is often how an operation gets dated.",
    },
  },
  {
    slug: "dns-lookup",
    name: "DNS lookup",
    summary:
      "A, AAAA, MX, NS, TXT and CAA records over DNS-over-HTTPS, with the CNAME chain, the DNSSEC flag and the difference between “no records” and “no such name” made explicit.",
    dataHandling: "onOurServer",
    group: "network",
    playbook: {
      slug: "investigating-a-domain-and-its-infrastructure",
      title: "Investigating a domain and its infrastructure",
      step: "Step 3 is emphatic that a hostname is not a host: certificate transparency and passive DNS both return large numbers of names that no longer resolve or never did, and stating that an organisation “has 340 subdomains” on the strength of an unresolved list is the characteristic error of this workflow. This is where each name gets resolved and the result recorded, including the negative ones.",
    },
  },
  {
    slug: "ip-intelligence",
    name: "IP intelligence",
    summary:
      "The covering prefix, the AS that announces it and who holds it, the registry's allocation country, BGP first- and last-seen dates, route visibility, and the network's own abuse contact.",
    dataHandling: "onOurServer",
    group: "network",
    playbook: {
      slug: "investigating-a-domain-and-its-infrastructure",
      title: "Investigating a domain and its infrastructure",
      step: "Step 4 maps the hosting using scan indexes rather than your own scanner, and asks you to record the ASN, the provider and the date of every observation. This tool supplies the routing half of that — including whether a CDN sits in front, which decides how much of everything downstream is about the target at all.",
    },
  },
  {
    slug: "wayback-explorer",
    name: "Wayback capture explorer",
    summary:
      "Every archived capture of a URL on one timeline, the dates its content actually changed read from the index digests, and a text diff between any two captures.",
    dataHandling: "onOurServer",
    group: "network",
    playbook: {
      slug: "investigating-a-domain-and-its-infrastructure",
      title: "Investigating a domain and its infrastructure",
      step: "Step 6 reconstructs the history, and says to use the CDX index rather than clicking through snapshots — it lists every capture with its timestamp and content digest, so you can see when the page actually changed rather than when it happened to be crawled. It also warns that a gap in captures usually means nobody crawled it, which is the most over-read signal in the whole workflow.",
    },
  },
  {
    slug: "overpass-builder",
    name: "Overpass query builder",
    summary:
      "Search OpenStreetMap for where a combination of mapped features co-occurs inside a bounding box, with the Overpass QL shown and editable, and the results on a map and in a table.",
    dataHandling: "viaOurServer",
    group: "place",
    playbook: {
      slug: "geolocating-from-imagery",
      title: "Geolocating from imagery",
      step: "Step 3 is the one that turns geolocation from luck into method, and the one most people skip because it means learning a query language for twenty minutes. It asks you to query for the co-occurrence of two or three distinctive mapped features inside a bounding box — and it is emphatic that a null result usually means your query, your tagging assumption or OpenStreetMap's coverage is wrong, not that the feature is absent.",
    },
  },
  {
    slug: "imagery-comparator",
    name: "Satellite imagery comparator",
    summary:
      "NASA MODIS and VIIRS imagery of the same place on two dates, side by side or under a swipe, daily and global back to February 2000.",
    dataHandling: "clientToSource",
    group: "place",
    playbook: {
      slug: "verifying-a-viral-videos-authenticity-and-timeline",
      title: "Verifying a viral video's authenticity and timeline",
      step: "Step 4 tests a claim against physical evidence the publisher did not control, and names satellite corroboration as one of the strongest available: imagery from before and after a claimed date shows damage, flooding, a burn scar or new construction independently of anything the video asserts. The step also states this tool's own limit — resolution shows that something changed, not what it is, and analysts routinely over-read those pixels.",
    },
  },
  {
    slug: "registry-lookup",
    name: "Aircraft and vessel identifier decoder",
    summary:
      "US N-number to ICAO 24-bit address and back, which state's block an address belongs to, and what an MMSI's digits say about the station transmitting it.",
    dataHandling: "inBrowser",
    group: "signals",
    playbook: {
      slug: "tracing-a-vessel-and-its-owner",
      title: "Tracing a vessel and its owner",
      step: "Step 1 fixes the vessel's permanent identity before anything else, because an MMSI changes when a hull reflags and is routinely re-programmed to another vessel's number in sanctions evasion. This decodes what an MMSI actually encodes — including whether the thing you are tracking is a ship at all rather than a buoy, a coast station or a distress beacon — and points at the registries that hold the record.",
    },
  },
  {
    slug: "broadcast-finder",
    name: "Broadcast finder",
    summary:
      "Public radio streams filtered by country, region, language, tag or name, played directly from the broadcaster — with the fifth of the catalogue a browser cannot play labelled rather than hidden.",
    dataHandling: "viaOurServer",
    group: "signals",
    playbook: {
      slug: "verifying-a-viral-videos-authenticity-and-timeline",
      title: "Verifying a viral video's authenticity and timeline",
      step: "Step 4 asks you to test a claim against at least one independent source the publisher does not control, and to record what each check returned including the ones that returned nothing. Live local radio is that kind of source during an unfolding event: local, contemporaneous, in the local language, and outside the platforms the footage is spreading on. Its own limit is on the tool page — absence of local coverage constrains nothing on its own.",
    },
  },
];

export function findTool(slug: string): ToolbenchEntry | null {
  return TOOLBENCH_ENTRIES.find((entry) => entry.slug === slug) ?? null;
}

export function toolsInGroup(group: ToolGroup): readonly ToolbenchEntry[] {
  return TOOLBENCH_ENTRIES.filter((entry) => entry.group === group);
}

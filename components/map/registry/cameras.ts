import type { SourceFeature } from "@/lib/sources/types";
import type { LayerMedia, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, instantValue, numberProp, stringProp } from "./props";

/**
 * Traffic and road cameras — a registry of where cameras are, not a wall of pictures.
 *
 * ## This layer's value is the detail panel, not the marker
 *
 * The other layers here draw something that is happening. This one draws something that
 * exists: a fixed camera at a published location, with an operator, a licence, an
 * attribution string that licence makes mandatory, and a date on which a human last checked
 * all of it. Nothing about it changes minute to minute, which is why the source makes no
 * outbound call at all and reports its own age as the date it was last verified rather than
 * the moment it was read.
 *
 * ## Nothing connects to an operator until the reader asks — ADR 0015
 *
 * Camera imagery is never proxied (product-brief §2b): relaying the bytes would exhaust a
 * small VPS and turn a linking site into a rebroadcasting one. So the image URL is handed to
 * the reader rather than fetched by us, and the reader's browser is what connects — which
 * means the operator sees their IP address and precisely which location they are looking at.
 * ADR 0015 requires that consequence to be **disclosed before it happens, in plain words**,
 * which is what the "Connecting to this camera" row in the detail panel is for.
 *
 * **The panel renders the view itself, behind an explicit press** (`MapLayerDefinition.media`,
 * added 2026-09-01 to close the gap this file used to describe). Nothing loads until the reader
 * asks; the control names the host in its own label; the media carries
 * `referrerPolicy="no-referrer"` so the operator learns that somebody loaded it but not from
 * which of our pages; and the credit its licence demands is rendered beside it. Every camera
 * that reaches this layer has a confirmed embed permission — `lib/sources/traffic-cameras.ts`
 * drops `embedPermitted: false` and the link-only registry before we ever see it. **If a
 * provider is ever added whose permission is not confirmed, its features must return
 * `kind: "link"` instead**, which is the same disclosure in the more obvious form (ADR 0015
 * point 5).
 *
 * ## Stills, clips and live streams are three different claims — see `cameraView`
 *
 * The adapter publishes each form separately and never conflates them: `stillUrl`, `videoUrl`
 * and `streamUrl`, each an explicit `null` where the operator publishes none. TfL, for one,
 * publishes a short MP4 for every JamCam beside the still, from the same S3 origin under the
 * same licence.
 *
 * The panel embeds the most informative form a camera has — stream, else clip, else still — and
 * **states which of the three it is, in those words**. A clip the operator replaces every few
 * minutes is not live, and this layer will not let one be labelled that way: the kind comes from
 * which field the URL was in, and `resolveMedia` independently refuses a record whose kind
 * contradicts its own URL.
 *
 * ## Which cameras are here, and which are deliberately not
 *
 * Only providers whose embed permission was read and recorded: Transport for London's
 * JamCams and Fintraffic's road weather cameras. `content/cameras/link-only-providers.json`
 * holds networks that are unambiguously published but where an embed permission or a stable
 * URL could not be confirmed; the adapter excludes that file, and additionally drops any
 * camera marked `embedPermitted: false`. Unsecured cameras indexed by third parties are not
 * in this product at any layer — the conventions §2 rule 6: intentionally published is not the same
 * as merely reachable.
 *
 * ## The property names this file reads
 *
 * From `lib/sources/cameras/provider.ts` (`CameraFeature`), and listed in
 * `docs/frontend/HANDOFF-map.md` §3:
 *
 *   operator             string   the body that runs the camera
 *   providerName         string   the registry file it came from, e.g. TfL (JamCams)
 *   jurisdiction         string   ISO country code
 *   locationLabel        string   human-readable location
 *   stillUrl             string   the still image THE CLIENT loads, never our server, or null
 *   embedUrl             string   the same value under the name this file used to read. Kept by
 *                                 the adapter so the shape change and the player could land
 *                                 independently; read only as a fallback for `stillUrl`
 *   videoUrl             string   a video FILE, regenerated periodically. Not live, ever
 *   videoRefreshSeconds  number   the operator's DOCUMENTED replacement interval, or null
 *   streamUrl            string   a genuinely live manifest, or null
 *   mediaForms           string   comma-joined subset of `still,video,stream`
 *   hasLiveStream        boolean  true only when `streamUrl` is set
 *   available            boolean  the operator's own flag; false means they say it is out
 *   attribution          string   the per-camera credit its licence makes mandatory
 *   attributionRequired  boolean  whether that credit is a condition of use
 *   licence              string   the licence this camera is published under
 *   subject              string   what the camera looks at
 *   confidence           string   verified | high | medium | needsReview (product-brief §6)
 *   lastVerifiedAt       string   ISO date a human last checked this entry
 *
 * ## Why there is no `precision` on this layer
 *
 * Camera coordinates on a map are often geocoded from a road name, and if these were, they
 * would need the same caveat the weather layer carries. **These are not.** Every entry's
 * `confidenceNotes` in `content/cameras/*.json` records the coordinates as read from the
 * operator's own API — TfL's Unified API and Digitraffic's stations endpoint — on a stated
 * date. Caveating a position the operator itself published would be caveating everything,
 * which is the same as caveating nothing. If a provider is ever added whose positions are
 * derived rather than published, that provider's features need the caveat and this note needs
 * rewriting.
 */

/** --green-300 #84DE9A and --green-600 #1F7D39, per `app/tokens.css` §1. */
const GREEN_300: Rgba = [132, 222, 154, 220];
const GREEN_600: Rgba = [31, 125, 57, 235];

/** The host a reader would be connecting to, or null if the URL will not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    /* A registry entry with an unparseable URL still renders every other row. */
    return null;
  }
}

/** `31 August 2026`. A date a human checked, so it is written as a date, not a clock time. */
function formatVerifiedAt(feature: SourceFeature): string | null {
  const date = instantProp(feature, "lastVerifiedAt");
  if (!date) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * The ADR 0015 disclosure, per camera, naming the host it applies to.
 *
 * It is a detail row rather than a footnote because the reader who is about to open the image
 * is reading this panel, and a disclosure they meet after connecting is not a disclosure.
 */
function connectionDisclosure(feature: SourceFeature, host: string): string {
  const operator = stringProp(feature, "operator") ?? "the operator";
  /*
   * "This view" rather than "this image": the same camera may publish a still, a short clip or
   * a live stream, and a disclosure that names the wrong one is a small false statement in the
   * sentence whose entire job is being true.
   */
  return (
    `Opening this view connects your browser directly to ${host}, which is ${operator}'s ` +
    `host rather than ours. They will see your IP address and which camera you asked for. ` +
    `We never fetch or re-host the picture, so nothing about it passes through us — and we do ` +
    `not know which cameras anyone has looked at.`
  );
}

/**
 * The credit, and whether it is a condition of use rather than a courtesy.
 *
 * Both providers here make attribution mandatory, in wording of their own: TfL's includes the
 * Ordnance Survey Crown copyright notice, and Fintraffic's is the CC BY 4.0 credit. A single
 * blended string would satisfy neither licence, which is why this is per camera and why it is
 * rendered verbatim.
 */
function requiredCredit(feature: SourceFeature): string | null {
  const attribution = stringProp(feature, "attribution");
  if (attribution === null) return null;
  return boolProp(feature, "attributionRequired") === true
    ? `${attribution} (required by the licence, and must be shown wherever the image is)`
    : attribution;
}

/**
 * WHICH VIEW OF THIS CAMERA THE PANEL EMBEDS, AND WHAT IT IS ALLOWED TO CALL IT.
 *
 * `lib/sources/cameras/provider.ts` publishes each form separately and never conflates them:
 * `stillUrl`, `videoUrl` and `streamUrl`, each with an explicit `null` when the operator
 * publishes none, plus `hasLiveStream` which it describes as "the one flag a player should read
 * before it writes the word 'live' anywhere near a timestamp". This is that player.
 *
 * **Order: live stream, then clip, then still.** The owner's ask is moving pictures where they
 * exist, and where a camera publishes both a stream and a still the stream is the one that
 * answers "what is happening there now". Nothing is lost by the choice: `mediaForms` renders as
 * a detail row, so a reader can see that a still also exists, and the URL of what is embedded is
 * a copyable row beside it.
 *
 * **A clip is never promoted to a stream.** A `videoUrl` gets `kind: "video"` however moving its
 * pictures are, and `resolveMedia` refuses a record whose kind contradicts its own URL, so the
 * mistake cannot be made silently on either side.
 */
function cameraView(
  feature: SourceFeature,
): { readonly kind: "image" | "video" | "stream"; readonly url: string } | null {
  const stream = stringProp(feature, "streamUrl");
  if (stream !== null) return { kind: "stream", url: stream };

  const video = stringProp(feature, "videoUrl");
  if (video !== null) return { kind: "video", url: video };

  /*
   * `stillUrl` is the current name; `embedUrl` is the same value under the name this file used
   * to read, kept by the adapter so the shape change and the player could land independently.
   * Both are read so neither team had to wait for the other, and dropping the fallback is a
   * one-line change once the adapter stops emitting it.
   */
  const still = stringProp(feature, "stillUrl") ?? stringProp(feature, "embedUrl");
  return still === null ? null : { kind: "image", url: still };
}

/**
 * The operator's own replacement interval for a clip, as a sentence, or null.
 *
 * `videoRefreshSeconds` is documented in the adapter as "the operator's documented interval in
 * seconds, or null if they publish none", so this formats a published fact rather than inventing
 * one. Where an operator publishes nothing this renders nothing — a plausible-sounding
 * "refreshed every few minutes" is exactly the sentence that would later be quoted back as
 * though a transport authority had said it (product-brief §6).
 *
 * "About", always: rounding an exact interval understates our precision and never overstates it.
 */
function clipRefreshNote(feature: SourceFeature): string | null {
  const seconds = numberProp(feature, "videoRefreshSeconds");
  if (seconds === null || seconds <= 0) return null;
  const operator = stringProp(feature, "operator") ?? "The operator";
  const interval =
    seconds < 90
      ? `${Math.round(seconds)} seconds`
      : `${Math.round(seconds / 60)} minutes`;
  return `${operator} documents this file as replaced about every ${interval}.`;
}

/**
 * The camera's own view, loaded by the reader's browser and never by ours.
 *
 * The credit is the provider's **verbatim** string. `requiredCredit` above adds a clause saying
 * the licence demands it, which is right in a labelled detail row and wrong printed under a
 * photograph: a credit line has to be the words the licence asks for, and nothing else.
 */
function cameraMedia(feature: SourceFeature): LayerMedia | null {
  const view = cameraView(feature);
  if (view === null) return null;

  const host = hostOf(view.url);
  if (host === null) return null;

  const base = {
    url: view.url,
    host,
    disclosure: connectionDisclosure(feature, host),
    credit: stringProp(feature, "attribution"),
  } as const;

  switch (view.kind) {
    case "stream":
      /* A traffic camera's HLS carries pictures. Radio is the only audio-only stream we hold. */
      return { ...base, kind: "stream", medium: "video" };
    case "video":
      return { ...base, kind: "video", refreshNote: clipRefreshNote(feature) };
    default:
      return { ...base, kind: "image" };
  }
}

export const camerasLayer: MapLayerDefinition = {
  id: "cameras",
  sourceSlug: "traffic-cameras",
  kind: "cameras",
  label: "Traffic cameras",
  description:
    "Road and traffic cameras from operators whose licences we have read and recorded — Transport for London and Fintraffic — so coverage is London and Finland rather than the world. The map shows where the cameras are; opening an image connects your browser to the operator directly and we never relay it.",
  defaultVisible: false,

  colour: { dark: GREEN_300, light: GREEN_600, token: "--green-300 / --green-600" },

  legend: {
    label: "Traffic cameras",
    symbol: "circle",
    note: "One dot per camera at a fixed published location. Nothing loads from an operator until you ask it to.",
  },

  deck: (kit, input) =>
    new kit.ScatterplotLayer<SourceFeature>({
      id: input.id,
      data: input.features,
      pickable: true,
      stroked: true,
      filled: true,
      radiusUnits: "pixels",
      lineWidthUnits: "pixels",
      getPosition: (f) => [f.longitude, f.latitude],
      /*
       * One size for every camera. Nothing about a camera is graduated — it exists or it does
       * not — and varying the radius would imply a magnitude this layer does not have. Six
       * pixels clears the 4 px hit-target floor comfortably, which matters here because these
       * are the features a reader most often wants to open rather than merely see.
       */
      getRadius: 6,
      getFillColor: input.colour,
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /* A fixed camera does not move. There is nothing here to animate. */
      transitions: {},
      onClick: (info) => {
        if (info.object) input.onSelect(info.object.id);
        return true;
      },
    }),

  columns: [
    {
      key: "camera",
      label: "camera",
      numeric: false,
      rowHeader: true,
      initialDirection: "asc",
      value: (f) => f.label,
    },
    {
      key: "operator",
      label: "operator",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "operator"),
    },
    {
      key: "locationLabel",
      label: "location",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "locationLabel"),
    },
    {
      key: "subject",
      label: "view",
      numeric: false,
      initialDirection: "asc",
      value: (f) => stringProp(f, "subject"),
    },
    {
      /*
       * The verification date is a column rather than a detail row because it is the honest
       * age of this layer: nothing here is live, and a reader scanning the table should see
       * how old the claim is without opening anything.
       */
      key: "lastVerifiedAt",
      label: "checked",
      numeric: true,
      initialDirection: "desc",
      value: (f) => instantValue(f, "lastVerifiedAt"),
      format: formatVerifiedAt,
    },
  ],

  detail: [
    { label: "Operator", value: (f) => stringProp(f, "operator") },
    { label: "Network", value: (f) => stringProp(f, "providerName") },
    { label: "Location", value: (f) => stringProp(f, "locationLabel") },
    { label: "Jurisdiction", value: (f) => stringProp(f, "jurisdiction"), mono: true },
    { label: "What it looks at", value: (f) => stringProp(f, "subject") },
    { label: "Licence", value: (f) => stringProp(f, "licence") },
    { label: "Required credit", value: requiredCredit },
    /*
     * Still shown as text, and still not a link, now that the view loads in the panel. It is
     * here to be copied into a note or a citation; the thing that actually connects is the
     * disclosed control below, which is the only place a stray tap can reach an operator.
     *
     * "View URL" rather than "Image URL" because the same field may hold a still, a clip or a
     * manifest, and an investigator copying it into a citation should not be told it is a
     * picture when it is not.
     */
    { label: "View URL", value: (f) => cameraView(f)?.url ?? null, mono: true },
    {
      /*
       * WHAT THIS CAMERA PUBLISHES, not merely what the panel chose to embed. A camera with a
       * clip and a still shows one of them; a reader deciding whether to open a moving picture
       * on a metered connection, or citing what the operator makes available, needs both named.
       */
      label: "Published forms",
      value: (f) => stringProp(f, "mediaForms")?.split(",").join(", ") ?? null,
    },
    {
      /*
       * The OPERATOR'S own flag, rendered only when it is bad news. A row reading "available:
       * yes" on every camera trains a reader to skip it, and then the one that says no is
       * skipped too.
       */
      label: "Operator status",
      value: (f) =>
        boolProp(f, "available") === false
          ? "The operator currently reports this camera as out of service."
          : null,
    },
    { label: "Entry last checked", value: formatVerifiedAt },
    {
      /*
       * Our own confidence in the record, on product-brief §6's scale. It belongs beside the
       * data rather than in a methodology page: an entry marked `needsReview` is still worth
       * showing, and hiding the grading would make every entry look equally certain.
       */
      label: "Record confidence",
      value: (f) => stringProp(f, "confidence"),
      mono: true,
    },
  ],

  media: cameraMedia,

  /*
   * A registry, not a feed. `observedAt` is the newest `lastVerifiedAt` in
   * `content/cameras/*.json` — the date a human actually checked — so the status row says
   * "Checked 31 August 2026" rather than calling a hand-verified list "Live" and rendering its
   * verification date as 26 hours of decay.
   */
  cadence: "registry",

  defaultSort: { key: "camera", direction: "asc" },

  emptyMessage:
    "The camera registry lists no cameras we have confirmed we may show. Networks where an embed permission or a stable image URL could not be confirmed are kept out of this layer on purpose and are catalogued in the directory instead.",
  unavailableTitle: "Traffic cameras unavailable",
};

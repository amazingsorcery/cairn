import type { SourceFeature } from "@/lib/sources/types";
import type { LayerMedia, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, instantValue, stringProp } from "./props";

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
 * **The panel renders the image itself, behind an explicit press** (`MapLayerDefinition.media`,
 * added 2026-09-01 to close the gap this file used to describe). Nothing loads until the reader
 * asks; the control names the host in its own label; the image carries
 * `referrerPolicy="no-referrer"` so the operator learns that somebody loaded it but not from
 * which of our pages; and the credit its licence demands is rendered beside it. Every camera
 * that reaches this layer has a confirmed embed permission — `lib/sources/traffic-cameras.ts`
 * drops `embedPermitted: false` and the link-only registry before we ever see it — so `media`
 * returns `kind: "image"` here. **If a provider is ever added whose permission is not
 * confirmed, its features must return `kind: "link"` instead**, which is the same disclosure in
 * the more obvious form (ADR 0015 point 5).
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
 * From `lib/sources/traffic-cameras.ts`, and listed in `docs/frontend/HANDOFF-map.md` §3:
 *
 *   operator             string   the body that runs the camera
 *   providerName         string   the registry file it came from, e.g. TfL (JamCams)
 *   jurisdiction         string   ISO country code
 *   locationLabel        string   human-readable location
 *   embedUrl             string   the image URL THE CLIENT loads, never our server
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
function embedHost(feature: SourceFeature): string | null {
  const url = stringProp(feature, "embedUrl");
  if (url === null) return null;
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
function connectionDisclosure(feature: SourceFeature): string | null {
  const host = embedHost(feature);
  if (host === null) return null;
  const operator = stringProp(feature, "operator") ?? "the operator";
  return (
    `Opening this image connects your browser directly to ${host}, which is ${operator}'s ` +
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
 * The camera's own picture, loaded by the reader's browser and never by ours.
 *
 * The credit is the provider's **verbatim** string. `requiredCredit` below adds a clause
 * saying the licence demands it, which is right in a labelled detail row and wrong printed
 * under a photograph: a credit line has to be the words the licence asks for, and nothing else.
 */
function cameraMedia(feature: SourceFeature): LayerMedia | null {
  const url = stringProp(feature, "embedUrl");
  const host = embedHost(feature);
  const disclosure = connectionDisclosure(feature);
  if (url === null || host === null || disclosure === null) return null;
  return {
    kind: "image",
    url,
    host,
    disclosure,
    credit: stringProp(feature, "attribution"),
  };
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
     * Still shown as text, and still not a link, now that the image loads in the panel. It is
     * here to be copied into a note or a citation; the thing that actually connects is the
     * disclosed control below, which is the only place a stray tap can reach an operator.
     */
    { label: "Image URL", value: (f) => stringProp(f, "embedUrl"), mono: true },
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

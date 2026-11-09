import type { SourceFeature } from "@/lib/sources/types";
import type { LayerMedia, MapLayerDefinition, Rgba } from "./types";
import { boolProp, instantProp, instantValue, numberProp, stringProp } from "./props";

/**
 * Traffic cameras: a hand-checked registry of fixed cameras (TfL JamCams, Fintraffic road
 * weather cameras). The source makes no outbound call; its age is the last verification date.
 *
 * Imagery is never proxied. The panel loads the view in the reader's browser only on an
 * explicit press, after a disclosure naming the host, with the licence credit beside it.
 * Only cameras with a confirmed embed permission reach this layer (`lib/sources/traffic-cameras.ts`
 * drops the rest); a provider without one must use `kind: "link"`. Unsecured cameras indexed
 * by third parties are never included.
 *
 * Stills, clips and live streams are separate fields (`stillUrl`, `videoUrl`, `streamUrl`);
 * see `cameraView`.
 *
 * Properties read (from `CameraFeature` in `lib/sources/cameras/provider.ts`):
 *
 *   operator             string   the body that runs the camera
 *   providerName         string   the registry file it came from, e.g. TfL (JamCams)
 *   jurisdiction         string   ISO country code
 *   locationLabel        string   human-readable location
 *   stillUrl             string   still image the client loads, or null
 *   embedUrl             string   legacy name for `stillUrl`; fallback only
 *   videoUrl             string   a periodically regenerated video file; never live
 *   videoRefreshSeconds  number   the operator's documented replacement interval, or null
 *   streamUrl            string   a live manifest, or null
 *   mediaForms           string   comma-joined subset of `still,video,stream`
 *   hasLiveStream        boolean  true only when `streamUrl` is set
 *   available            boolean  the operator's own flag; false means out of service
 *   attribution          string   the per-camera credit its licence requires
 *   attributionRequired  boolean  whether that credit is a condition of use
 *   licence              string   the licence this camera is published under
 *   subject              string   what the camera looks at
 *   confidence           string   verified | high | medium | needsReview
 *   lastVerifiedAt       string   ISO date a human last checked this entry
 *
 * No `precision`: coordinates come from the operators' own APIs, not geocoding. A provider
 * with derived positions would need the caveat.
 */

/** --green-300 #84DE9A and --green-600 #1F7D39, per `app/tokens.css`. */
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

/** The per-camera connection disclosure, naming the host. */
function connectionDisclosure(feature: SourceFeature, host: string): string {
  const operator = stringProp(feature, "operator") ?? "the operator";
  /* "View", not "image": it may be a still, a clip or a stream. */
  return (
    `Opening this view connects your browser directly to ${host}, which is ${operator}'s ` +
    `host rather than ours. They will see your IP address and which camera you asked for. ` +
    `We never fetch or re-host the picture, so nothing about it passes through us — and we do ` +
    `not know which cameras anyone has looked at.`
  );
}

/**
 * The per-camera credit, verbatim (TfL's includes the Ordnance Survey Crown copyright notice;
 * Fintraffic's is CC BY 4.0), noting when it's a condition of use.
 */
function requiredCredit(feature: SourceFeature): string | null {
  const attribution = stringProp(feature, "attribution");
  if (attribution === null) return null;
  return boolProp(feature, "attributionRequired") === true
    ? `${attribution} (required by the licence, and must be shown wherever the image is)`
    : attribution;
}

/**
 * Which view the panel embeds: live stream, else clip, else still. Other published forms
 * are listed in the "Published forms" row.
 *
 * A `videoUrl` is always `kind: "video"`, never a stream; `resolveMedia` also rejects a
 * record whose kind contradicts its URL.
 */
function cameraView(
  feature: SourceFeature,
): { readonly kind: "image" | "video" | "stream"; readonly url: string } | null {
  const stream = stringProp(feature, "streamUrl");
  if (stream !== null) return { kind: "stream", url: stream };

  const video = stringProp(feature, "videoUrl");
  if (video !== null) return { kind: "video", url: video };

  /* `embedUrl` is the legacy name for `stillUrl`; drop the fallback once the adapter does. */
  const still = stringProp(feature, "stillUrl") ?? stringProp(feature, "embedUrl");
  return still === null ? null : { kind: "image", url: still };
}

/**
 * The operator's documented clip replacement interval as a sentence, or null when they
 * publish none (we never guess). "About" because the value is rounded.
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
 * The camera's view, loaded by the reader's browser. The credit is the raw attribution
 * string, without the clause `requiredCredit` adds for the detail row.
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
      /* Camera HLS is video; only radio streams are audio. */
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
      /* Fixed size: there's no magnitude to encode. */
      getRadius: 6,
      getFillColor: input.colour,
      getLineColor: (f) => (f.id === input.selectedId ? input.selectedColour : input.colour),
      getLineWidth: (f) => (f.id === input.selectedId ? 3 : 1),
      updateTriggers: {
        getFillColor: [input.colour],
        getLineColor: [input.selectedId, input.colour, input.selectedColour],
        getLineWidth: [input.selectedId],
      },
      /* Fixed cameras; nothing to animate. */
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
      /* The verification date is this layer's real age, so it's a column. */
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
     * Plain text for copying, not a link; only the disclosed control connects. "View" since
     * it may be a still, clip or manifest.
     */
    { label: "View URL", value: (f) => cameraView(f)?.url ?? null, mono: true },
    {
      /* Every form the camera publishes, not just the one embedded. */
      label: "Published forms",
      value: (f) => stringProp(f, "mediaForms")?.split(",").join(", ") ?? null,
    },
    {
      /* Operator's flag, shown only when out of service. */
      label: "Operator status",
      value: (f) =>
        boolProp(f, "available") === false
          ? "The operator currently reports this camera as out of service."
          : null,
    },
    { label: "Entry last checked", value: formatVerifiedAt },
    {
      /* Our confidence grading for the record, shown with the data. */
      label: "Record confidence",
      value: (f) => stringProp(f, "confidence"),
      mono: true,
    },
  ],

  media: cameraMedia,

  /* `observedAt` is the newest `lastVerifiedAt`, so the status shows a check date, not "Live". */
  cadence: "registry",

  defaultSort: { key: "camera", direction: "asc" },

  emptyMessage:
    "The camera registry lists no cameras we have confirmed we may show. Networks where an embed permission or a stable image URL could not be confirmed are kept out of this layer on purpose and are catalogued in the directory instead.",
  unavailableTitle: "Traffic cameras unavailable",
};

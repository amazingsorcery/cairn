"use client";

import * as React from "react";
import { ExternalLink, Film, Image as ImageIcon, PlugZap, Radio, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LayerMedia } from "../registry/types";
import { attachHlsStream } from "./hls";
import type { HlsModuleLoader } from "./hls";

/**
 * One feature's picture, clip, audio or live stream: disclosed, then connected only if the
 * reader says so.
 *
 * ## The rules, which are ADR 0015's and product-brief §2b's rather than this file's
 *
 * - **Nothing connects until the reader presses the control.** The `<img>`, `<audio>` and
 *   `<video>` do not exist in the DOM before that. No `preconnect`, no prefetch, no poster
 *   image, no thumbnail warming — every one of those is a sensible-looking optimisation that
 *   silently repeals the decision, and a `poster` in particular looks like a picture and is
 *   actually a request to the operator before the reader agreed to one.
 * - **The connection is disclosed first, in plain words, naming the host**, and the host is
 *   repeated in the control's own label so a reader who reads only the button still learns what
 *   pressing it does. `resolveMedia` refuses a record whose host disagrees with its URL.
 * - **Our server never carries these bytes.** The browser talks to the operator directly.
 * - **`preload="none"`, no autoplay, no poster, controls always present.** Referrer suppression
 *   is `referrerPolicy="no-referrer"` on the `<img>`, and for media elements — where HTML
 *   defines no such attribute — it is the site-wide `Referrer-Policy: no-referrer` header in
 *   `infra/Caddyfile`. Writing the attribute on a `<video>` would be markup the browser ignores
 *   that reads like a guarantee.
 * - **Disconnecting unmounts the element**, which is the only thing that actually ends the
 *   connection. Destroying the HLS instance is the same act for a stream.
 * - **The credit the licence requires renders beside the media**, not in a footer.
 *
 * ## `video` and `stream` are not the same thing and this panel will not pretend they are
 *
 * A `video` is a file. TfL replaces the MP4 behind each JamCam every few minutes; the reader's
 * browser downloads whatever is there now and it does not advance while they watch. A `stream`
 * is an HLS manifest whose segments keep arriving. Both are moving pictures and only one of
 * them is live, so the panel states which, in those words, above the control — and where the
 * operator publishes a refresh cadence, it says that too, in the operator's words and never in
 * an estimate of ours.
 *
 * Collapsing the two would be the cheapest possible lie: an investigator looking at an empty
 * road on a five-minute-old clip labelled "live" would draw a conclusion about the road as it
 * is now.
 *
 * ## Focus
 *
 * Pressing "load" removes the button that was focused, and pressing "disconnect" removes that
 * one. Without moving focus, a keyboard reader is dropped onto `<body>` mid-panel and a screen
 * reader announces nothing — which reads as the press having failed. Focus moves to whichever
 * control took the other's place, and that announcement doubles as confirmation.
 */

export interface MediaPanelProps {
  readonly media: LayerMedia;
  /** Names the subject in the media element's accessible name. A camera or station name. */
  readonly subjectLabel: string;
  /**
   * Where to send a reader whose browser cannot play a stream — the operator's own page.
   * `null` when the caller has none, in which case the manifest URL itself is offered with an
   * honest warning about what the browser will probably do with it.
   */
  readonly fallbackUrl?: string | null;
  /**
   * Test seam. Production passes nothing and `attachHlsStream` uses the dynamic import in
   * `hls.ts`, which is what keeps the library out of every route's initial bundle.
   */
  readonly hlsLoader?: HlsModuleLoader;
}

/** What went wrong, as a sentence the reader can act on. `null` means nothing has. */
type Problem = string | null;

export function MediaPanel({ media, subjectLabel, fallbackUrl, hlsLoader }: MediaPanelProps) {
  const [open, setOpen] = React.useState(false);
  const [problem, setProblem] = React.useState<Problem>(null);

  const loadRef = React.useRef<HTMLButtonElement | null>(null);
  const disconnectRef = React.useRef<HTMLButtonElement | null>(null);
  const moved = React.useRef(false);

  React.useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    if (open) disconnectRef.current?.focus();
    else loadRef.current?.focus();
  }, [open]);

  function press(next: boolean) {
    moved.current = true;
    setProblem(null);
    setOpen(next);
  }

  return (
    <section
      aria-label={`Media from ${media.host}`}
      className="mt-4 rounded-md border border-dashed border-border p-3"
    >
      {/*
        THE DISCLOSURE IS ABOVE THE CONTROL AND STAYS THERE. A reader deciding whether to reveal
        their address to a camera operator has to be able to read the consequence before acting,
        and to re-read it afterwards without undoing anything. ADR 0015 point 2.
      */}
      <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
        {media.disclosure}
      </p>

      <MediaNature media={media} />

      {media.kind === "link" ? (
        <p className="mt-3">
          <a
            href={media.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium underline underline-offset-4 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            open the stream at {media.host}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      ) : !open ? (
        <Button
          ref={loadRef}
          variant="secondary"
          className="mt-3 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
          onClick={() => press(true)}
        >
          <MediaIcon kind={media.kind} />
          {/* The consequence is IN the label, not only in the paragraph above it. */}
          {controlVerb(media)} — connects you directly to {media.host}
        </Button>
      ) : (
        <div className="mt-3">
          {problem ? (
            <p className="max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
              {problem}
            </p>
          ) : (
            <MediaElement
              media={media}
              subjectLabel={subjectLabel}
              onProblem={setProblem}
              hlsLoader={hlsLoader}
            />
          )}

          {/*
            THE CREDIT SITS WITH THE MEDIA, because that is what the licence asks for. TfL's
            wording carries the Ordnance Survey notice and CC BY carries Fintraffic's; neither
            is satisfied by a line in a footer. Null means the licence asks for nothing, which
            is true of a public-domain dedication and false of everything else here.
          */}
          {media.credit && !problem ? (
            <p className="mt-2 max-w-[68ch] text-xs leading-relaxed text-foreground-secondary">
              {media.credit}
            </p>
          ) : null}

          {problem ? <FallbackLink media={media} fallbackUrl={fallbackUrl ?? null} /> : null}

          <Button
            ref={disconnectRef}
            variant="ghost"
            className="mt-2 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left"
            onClick={() => press(false)}
          >
            <PlugZap className="size-4 shrink-0" aria-hidden="true" />
            {/* Unmounting the element is what actually ends the connection. */}
            disconnect from {media.host}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * WHAT THE READER IS ABOUT TO BE LOOKING AT, for the two kinds a reader could otherwise
 * reasonably mistake for each other. It renders before the control, because the distinction is
 * part of the decision, and it stays after it, because it is part of reading the picture.
 */
function MediaNature({ media }: { media: LayerMedia }) {
  if (media.kind === "video") {
    return (
      <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
        <span className="font-semibold text-foreground">A video file, not a live stream.</span>{" "}
        Your browser downloads whatever clip {media.host} last published; it does not advance
        while you watch it, and it is not the scene as it is now.
        {media.refreshNote ? ` ${media.refreshNote}` : ""} Nothing is fetched until you press
        play in the player.
      </p>
    );
  }

  if (media.kind === "stream") {
    return (
      <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-foreground-secondary">
        <span className="font-semibold text-foreground">A live stream.</span> Your browser keeps
        fetching new segments from {media.host} for as long as the player is open, so the
        connection continues rather than happening once. Disconnecting is what ends it.
      </p>
    );
  }

  return null;
}

/** The element itself. Everything about it is an ADR 0015 rule rather than a preference. */
function MediaElement({
  media,
  subjectLabel,
  onProblem,
  hlsLoader,
}: {
  media: LayerMedia;
  subjectLabel: string;
  onProblem: (problem: string) => void;
  hlsLoader: HlsModuleLoader | undefined;
}) {
  if (media.kind === "image") {
    return (
      /*
        A PLAIN `<img>`, DELIBERATELY.

        `next/image` would route these bytes through our own optimiser, which is exactly the
        relaying ADR 0015 and product-brief §2b forbid: it would make this site a redistributor
        of an operator's imagery and put their traffic on our bandwidth.
        `referrerPolicy="no-referrer"` so the operator learns that somebody loaded the image but
        not which of our pages they were on (ADR 0015 point 3).
      */
      // eslint-disable-next-line @next/next/no-img-element -- next/image proxies the bytes through our server, which is the redistribution ADR 0015 forbids. This must be a direct browser-to-operator request.
      <img
        src={media.url}
        alt={`Image from ${subjectLabel}, loaded from ${media.host}. Nothing here describes what it shows.`}
        referrerPolicy="no-referrer"
        onError={() => onProblem(elementFailureSentence(media.host, "display"))}
        className="max-h-[60vh] w-full rounded-md border border-border object-contain"
      />
    );
  }

  if (media.kind === "audio") {
    return (
      /*
        NO CAPTION TRACK, and it is worth saying why rather than leaving a gap: a live radio
        stream has none to offer and we will not invent one. The station's name, language,
        country and homepage are in the panel above, which is the text equivalent a reader who
        cannot hear it actually gets. `jsx-a11y/media-has-caption` is not enabled in this repo's
        config, so there is no directive to leave here — a disable comment for a rule that is
        off is itself a lint warning.
      */
      <audio
        src={media.url}
        controls
        /*
          Playback starts because the control the reader just pressed says "play". This is
          user-initiated, not autoplay: the element did not exist a moment ago. There is no
          motion here, so `prefers-reduced-motion` has nothing to suppress — which is exactly
          why `video` and `stream` below do NOT do this.
        */
        autoPlay
        /* `none` matters even here: without it some browsers refetch on mount. */
        preload="none"
        onError={() => onProblem(elementFailureSentence(media.host, "play"))}
        className="w-full"
      >
        Your browser cannot play this stream.
      </audio>
    );
  }

  if (media.kind === "video") {
    return (
      <video
        src={media.url}
        controls
        /*
          NO `autoPlay`, NO `loop`, NO `poster`.

          Autoplaying video is motion that starts without being asked, which is what
          `prefers-reduced-motion` is about and what ADR 0015 forbids outright; `poster` is a
          request to the operator before the reader has pressed play, which is the click-to-load
          rule undone by an attribute. `preload="none"` means the element's mere existence
          fetches nothing at all — the first byte moves when the reader presses play.
        */
        preload="none"
        playsInline
        /*
          NO `referrerPolicy` HERE, and it is not an oversight. HTML defines that attribute on
          `<img>`, `<a>`, `<link>`, `<script>` and `<iframe>` — not on media elements, which
          take the document's policy. Writing it here would type-error, and adding a
          declaration for it would be worse: an attribute the browser ignores, sitting in the
          markup looking like a guarantee. The real one is `Referrer-Policy: no-referrer`, set
          site-wide in `infra/Caddyfile`, which covers this request and every other.
        */
        aria-label={`Video clip from ${subjectLabel}, played directly from ${media.host}`}
        onError={() => onProblem(elementFailureSentence(media.host, "play"))}
        className="max-h-[60vh] w-full rounded-md border border-border bg-black object-contain"
      >
        Your browser cannot play this clip.
      </video>
    );
  }

  if (media.kind === "stream") {
    return (
      <HlsPlayer
        url={media.url}
        host={media.host}
        medium={media.medium}
        subjectLabel={subjectLabel}
        onProblem={onProblem}
        hlsLoader={hlsLoader}
      />
    );
  }

  /* `link` never reaches here — the panel renders an anchor for it instead. */
  return null;
}

/**
 * A live HLS stream, played natively where the browser can and through a dynamically loaded
 * library where it cannot.
 *
 * The element is rendered first and wired up in an effect, because attaching needs the real
 * DOM node. Nothing is fetched by rendering it: `preload="none"`, no `src`, and the library —
 * when it is used at all — is requested inside the effect, which only runs because the reader
 * already pressed the disclosed control.
 */
function HlsPlayer({
  url,
  host,
  medium,
  subjectLabel,
  onProblem,
  hlsLoader,
}: {
  url: string;
  host: string;
  medium: "audio" | "video";
  subjectLabel: string;
  onProblem: (problem: string) => void;
  hlsLoader: HlsModuleLoader | undefined;
}) {
  const elementRef = React.useRef<HTMLMediaElement | null>(null);

  /*
   * Read through refs rather than listed as dependencies. `onProblem` is a new function on
   * every render of the panel and `hlsLoader` may be too; either in the dependency array would
   * tear the stream down and rebuild it on an unrelated re-render, which for a live connection
   * means dropping it and reconnecting to the operator without anyone asking.
   */
  const onProblemRef = React.useRef(onProblem);
  onProblemRef.current = onProblem;
  const loaderRef = React.useRef(hlsLoader);
  loaderRef.current = hlsLoader;

  React.useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    let cancelled = false;
    let detach: (() => void) | null = null;

    const options = {
      onFatalError: () => {
        if (!cancelled) onProblemRef.current(streamStoppedSentence(host));
      },
      ...(loaderRef.current ? { loader: loaderRef.current } : {}),
    };

    void attachHlsStream(element, url, options).then((result) => {
      if (cancelled) {
        if (result.mode === "library") result.detach();
        return;
      }
      if (result.mode === "library") detach = result.detach;
      if (result.mode === "unavailable") onProblemRef.current(unavailableSentence(result.reason));
    });

    return () => {
      cancelled = true;
      /* Destroying the instance is what stops the segment requests. Unmounting alone is not. */
      detach?.();
      element.removeAttribute("src");
    };
  }, [url, host]);

  const shared = {
    controls: true,
    /*
      No autoplay, for a live stream as much as for a clip: motion that starts by itself is
      what `prefers-reduced-motion` is about. The reader presses play in the element's own
      controls. `preload="none"` is belt and braces — there is no `src` to preload until
      either the native path sets one or the library attaches a MediaSource.
    */
    preload: "none" as const,
    className:
      medium === "audio"
        ? "w-full"
        : "max-h-[60vh] w-full rounded-md border border-border bg-black object-contain",
  };

  const label = `Live stream from ${subjectLabel}, played directly from ${host}`;

  if (medium === "audio") {
    return (
      <audio
        {...shared}
        aria-label={label}
        ref={(element) => {
          elementRef.current = element;
        }}
      >
        Your browser cannot play this stream.
      </audio>
    );
  }

  return (
    <video
      {...shared}
      playsInline
      /* Referrer suppression is the document's, not this element's. See the clip above. */
      aria-label={label}
      ref={(element) => {
        elementRef.current = element;
      }}
    >
      Your browser cannot play this stream.
    </video>
  );
}

/**
 * The way out when the in-page player cannot work. The stream is an enhancement; the
 * operator's own page always works, and a reader who came here to look at a camera must not be
 * left holding an error message.
 */
function FallbackLink({
  media,
  fallbackUrl,
}: {
  media: LayerMedia;
  fallbackUrl: string | null;
}) {
  const target = fallbackUrl ?? media.url;
  let host: string;
  try {
    host = new URL(target).host;
  } catch {
    return null;
  }

  return (
    <p className="mt-2">
      <a
        href={target}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex min-h-11 items-center gap-2 underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
        {fallbackUrl ? `open the source page at ${host}` : `open the stream URL at ${host}`}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      {fallbackUrl ? null : (
        <span className="ml-1 text-sm text-foreground-secondary">
          — a browser without a player for this will usually download the playlist rather than
          play it.
        </span>
      )}
    </p>
  );
}

function MediaIcon({ kind }: { kind: LayerMedia["kind"] }) {
  const className = "size-4 shrink-0";
  if (kind === "image") return <ImageIcon className={className} aria-hidden="true" />;
  if (kind === "audio") return <Volume2 className={className} aria-hidden="true" />;
  if (kind === "video") return <Film className={className} aria-hidden="true" />;
  return <Radio className={className} aria-hidden="true" />;
}

/**
 * The verb on the control. Distinct per kind on purpose: a reader scanning by controls hears
 * only this, and "play" on a clip and "play" on a live stream would be the same promise for two
 * different things.
 */
function controlVerb(media: LayerMedia): string {
  switch (media.kind) {
    case "image":
      return "load the image";
    case "audio":
      return "play";
    case "video":
      return "load the clip";
    case "stream":
      return "open the live stream";
    default:
      return "open";
  }
}

function elementFailureSentence(host: string, verb: "display" | "play"): string {
  return (
    `${host} did not answer, or sent something this browser will not ${verb}. That exchange ` +
    `was between your browser and them; nothing here is broken and nothing passed through ` +
    `this site.`
  );
}

function streamStoppedSentence(host: string): string {
  return (
    `The stream from ${host} stopped, or this browser was not allowed to fetch it. That ` +
    `exchange was between your browser and them; nothing passed through this site.`
  );
}

function unavailableSentence(reason: "player-unavailable" | "unsupported-browser"): string {
  return reason === "unsupported-browser"
    ? "This browser cannot play a live HLS stream: it has neither built-in support nor the " +
        "Media Source Extensions a player would need. Nothing about the stream itself is wrong."
    : "The player this browser needs for a live stream could not be loaded, so nothing was " +
        "requested from the operator. Nothing about the stream itself is known to be wrong.";
}

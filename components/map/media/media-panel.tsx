"use client";

import * as React from "react";
import { ExternalLink, Film, Image as ImageIcon, PlugZap, Radio, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LayerMedia } from "../registry/types";
import { attachHlsStream } from "./hls";
import type { HlsModuleLoader } from "./hls";

/**
 * A feature's image, clip, audio or live stream, loaded only on click.
 *
 * - No media element, preconnect, prefetch or poster before the press.
 * - The disclosure names the host, and so does the button label. `resolveMedia` rejects a
 *   record whose host doesn't match its URL.
 * - The browser talks to the operator directly; our server never carries the bytes.
 * - `preload="none"`, no autoplay/poster, controls always on. Referrer: `no-referrer` on
 *   `<img>`; media elements use the site-wide `Referrer-Policy` header (`infra/Caddyfile`).
 * - Disconnect unmounts the element (and destroys the HLS instance), which ends the connection.
 * - Licence credit renders next to the media.
 *
 * A `video` is a periodically replaced file (e.g. TfL JamCam MP4s); a `stream` is live HLS.
 * The panel says which, and only quotes a refresh cadence the operator publishes.
 *
 * Focus moves to the replacement button on load/disconnect, since the pressed one unmounts.
 */

export interface MediaPanelProps {
  readonly media: LayerMedia;
  /** Names the subject in the media element's accessible name. A camera or station name. */
  readonly subjectLabel: string;
  /**
   * The operator's page, for browsers that can't play the stream. When `null`, the manifest
   * URL is offered with a warning that it will probably download.
   */
  readonly fallbackUrl?: string | null;
  /** Test seam; production uses the dynamic import in `hls.ts`. */
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
      {/* Disclosure stays above the control, before and after connecting. */}
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
          {/* The label itself names the host. */}
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
            Credit next to the media, as the licences require (TfL incl. the Ordnance Survey
            notice; Fintraffic CC BY). Null means none required (public domain).
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
            {/* Unmounting the element ends the connection. */}
            disconnect from {media.host}
          </Button>
        </div>
      )}
    </section>
  );
}

/** Says whether a moving picture is a file or a live stream; shown before and after loading. */
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

/** The media element itself. */
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
      /* Plain `<img>`: `next/image` would proxy the operator's imagery through our server. */
      // eslint-disable-next-line @next/next/no-img-element -- must be a direct browser-to-operator request, not proxied by next/image.
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
        No caption track: live radio has none. The station details in the panel are the text
        equivalent.
      */
      <audio
        src={media.url}
        controls
        /*
          The reader just pressed "play" and the element mounts on that click, so this is
          user-initiated. Video below doesn't autoplay (reduced motion).
        */
        autoPlay
        /* Some browsers refetch on mount without this. */
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
          No autoplay, loop or poster (a poster would fetch before play). `preload="none"` so
          nothing is fetched until the reader presses play.
        */
        preload="none"
        playsInline
        /*
          No `referrerPolicy`: HTML doesn't define it on media elements. The site-wide
          `Referrer-Policy: no-referrer` header (`infra/Caddyfile`) covers this.
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
 * Live HLS stream, native where possible, otherwise via the lazily loaded library. Wired up
 * in an effect because attaching needs the DOM node; rendering alone fetches nothing.
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

  /* Refs, not deps: new callback identities would otherwise drop and reconnect the stream. */
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
      /* Destroying the instance stops segment requests; unmounting alone doesn't. */
      detach?.();
      element.removeAttribute("src");
    };
  }, [url, host]);

  const shared = {
    controls: true,
    /* No autoplay; the reader presses play. */
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
      /* Referrer policy comes from the document header (see the clip above). */
      aria-label={label}
      ref={(element) => {
        elementRef.current = element;
      }}
    >
      Your browser cannot play this stream.
    </video>
  );
}

/** Link out to the operator when the in-page player can't work. */
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

/** Control verb, distinct per kind so a clip and a live stream aren't labelled alike. */
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

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { LayerMedia } from "../registry/types";
import { MediaPanel } from "./media-panel";

/**
 * A `video` is a periodically replaced file; a `stream` is live HLS. The panel must never
 * call a clip live.
 *
 * Network behaviour: no element before the press, no `autoplay`, no `poster`, and no HLS
 * library on browsers that don't need it.
 */

const base = {
  host: "s3-eu-west-1.amazonaws.com",
  disclosure: "Opening this view connects your browser directly to s3-eu-west-1.amazonaws.com.",
  credit: "Powered by TfL Open Data.",
} as const;

const clip: LayerMedia = {
  ...base,
  kind: "video",
  url: "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.07450.mp4",
  refreshNote: null,
};

const liveStream: LayerMedia = {
  ...base,
  host: "stream.example.org",
  kind: "stream",
  medium: "video",
  url: "https://stream.example.org/live/master.m3u8",
  disclosure: "Opening this connects your browser directly to stream.example.org.",
};

function renderPanel(media: LayerMedia, props: Partial<React.ComponentProps<typeof MediaPanel>> = {}) {
  return render(<MediaPanel media={media} subjectLabel="Piccadilly Circus" {...props} />);
}

/** hls.js's documented surface, enough of it to attach and to fail. */
function fakeHlsModule() {
  const record = { loaded: [] as string[], destroyed: 0, fire: null as null | (() => void) };
  class FakeHls {
    static isSupported() {
      return true;
    }
    static readonly Events = { ERROR: "hlsError" } as const;
    loadSource(url: string) {
      record.loaded.push(url);
    }
    attachMedia() {}
    on(event: string, listener: (event: string, data: { fatal?: boolean }) => void) {
      if (event === "hlsError") record.fire = () => listener(event, { fatal: true });
    }
    destroy() {
      record.destroyed += 1;
    }
  }
  return { module: { default: FakeHls }, record };
}

describe("a video clip", () => {
  it("makes no outbound request until the reader asks", () => {
    const { container } = renderPanel(clip);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("button", { name: /load the clip/i })).toBeInTheDocument();
  });

  it("says it is a file and not live, before the reader presses anything", () => {
    renderPanel(clip);
    expect(screen.getByText(/a video file, not a live stream/i)).toBeInTheDocument();
    expect(screen.getByText(/does not advance while you watch/i)).toBeInTheDocument();
  });

  it("carries the operator's own refresh statement when the registry records one", () => {
    // Verbatim, and only when it exists; we never estimate a cadence.
    renderPanel({ ...clip, refreshNote: "TfL replaces this clip every five minutes." });
    expect(screen.getByText(/TfL replaces this clip every five minutes\./)).toBeInTheDocument();
  });

  it("says nothing about refresh when the operator publishes nothing", () => {
    renderPanel(clip);
    expect(screen.queryByText(/every few minutes/i)).not.toBeInTheDocument();
  });

  it("names the host in the disclosure and in the control's own label", () => {
    renderPanel(clip);
    const control = screen.getByRole("button", { name: /load the clip/i });
    expect(control.textContent).toContain("s3-eu-west-1.amazonaws.com");
  });

  it("plays the operator's own URL, with nothing preloaded", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(clip);
    await user.click(screen.getByRole("button", { name: /load the clip/i }));

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    // Never our origin; we don't relay video.
    expect(video?.getAttribute("src")).toBe(clip.url);
    expect(video?.getAttribute("preload")).toBe("none");
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("carries no `referrerpolicy` attribute, because HTML defines none on media elements", async () => {
    /*
     * `referrerpolicy` is ignored on <video>/<audio>; they use the document policy, which is
     * the site-wide `Referrer-Policy: no-referrer` header in `infra/Caddyfile`.
     */
    const user = userEvent.setup();
    const { container } = renderPanel(clip);
    await user.click(screen.getByRole("button", { name: /load the clip/i }));
    expect(container.querySelector("video")?.hasAttribute("referrerpolicy")).toBe(false);
  });

  it("never autoplays and never carries a poster", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(clip);
    await user.click(screen.getByRole("button", { name: /load the clip/i }));

    const video = container.querySelector("video");
    // `poster` would be a request to the operator before the reader presses play.
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(video?.hasAttribute("poster")).toBe(false);
    expect(video?.hasAttribute("loop")).toBe(false);
  });

  it("renders the credit the licence requires beside the clip", async () => {
    const user = userEvent.setup();
    renderPanel(clip);
    await user.click(screen.getByRole("button", { name: /load the clip/i }));
    expect(screen.getByText("Powered by TfL Open Data.")).toBeInTheDocument();
  });

  it("offers a way to stop, and unmounting the element is what does it", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel(clip);
    await user.click(screen.getByRole("button", { name: /load the clip/i }));
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(container.querySelector("video")).toBeNull();
  });

  it("keeps keyboard focus on the control that replaced the one just pressed", async () => {
    const user = userEvent.setup();
    renderPanel(clip);
    await user.click(screen.getByRole("button", { name: /load the clip/i }));
    expect(screen.getByRole("button", { name: /disconnect/i })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(screen.getByRole("button", { name: /load the clip/i })).toHaveFocus();
  });
});

describe("a live HLS stream", () => {
  it("makes no outbound request and loads no library until the reader asks", () => {
    const loader = vi.fn();
    const { container } = renderPanel(liveStream, { hlsLoader: loader });
    expect(container.querySelector("video")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /open the live stream/i })).toBeInTheDocument();
  });

  it("says it is live, and says the connection continues rather than happening once", () => {
    renderPanel(liveStream);
    expect(screen.getByText(/a live stream/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps fetching new segments/i)).toBeInTheDocument();
  });

  it("uses a different control label from the clip, because it is a different promise", () => {
    renderPanel(liveStream);
    // Screen readers navigating by controls hear only the label.
    expect(screen.queryByRole("button", { name: /load the clip/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open the live stream/i })).toBeInTheDocument();
  });

  it("attaches the library to the element and hands it the operator's own URL", async () => {
    const user = userEvent.setup();
    const { module, record } = fakeHlsModule();
    const { container } = renderPanel(liveStream, { hlsLoader: () => Promise.resolve(module) });

    await user.click(screen.getByRole("button", { name: /open the live stream/i }));
    await waitFor(() => expect(record.loaded).toEqual([liveStream.url]));

    const video = container.querySelector("video");
    // The library feeds the element through MediaSource, so no `src`.
    expect(video?.getAttribute("src")).toBeNull();
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("destroys the library instance on disconnect, which is what ends the connection", async () => {
    const user = userEvent.setup();
    const { module, record } = fakeHlsModule();
    renderPanel(liveStream, { hlsLoader: () => Promise.resolve(module) });

    await user.click(screen.getByRole("button", { name: /open the live stream/i }));
    await waitFor(() => expect(record.loaded).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    // Unmounting a <video> a library is still feeding does not stop the segment requests.
    await waitFor(() => expect(record.destroyed).toBe(1));
  });

  it("renders an <audio> element for a station rather than a video frame", async () => {
    const user = userEvent.setup();
    const { module } = fakeHlsModule();
    const { container } = renderPanel(
      { ...liveStream, medium: "audio" },
      { hlsLoader: () => Promise.resolve(module) },
    );
    await user.click(screen.getByRole("button", { name: /open the live stream/i }));
    // An .m3u8 says nothing about whether it carries pictures; the record has to.
    expect(container.querySelector("audio")).not.toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });

  it("says so and links out when the player cannot be loaded", async () => {
    const user = userEvent.setup();
    renderPanel(liveStream, {
      hlsLoader: () => Promise.reject(new Error("chunk load failed")),
      fallbackUrl: "https://operator.example.org/cameras/1",
    });

    await user.click(screen.getByRole("button", { name: /open the live stream/i }));

    // Falls back to the operator's own page.
    await waitFor(() =>
      expect(screen.getByText(/player this browser needs .* could not be loaded/i)).toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: /open the source page at operator\.example\.org/i });
    expect(link.getAttribute("href")).toBe("https://operator.example.org/cameras/1");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("says something different when it is the browser that cannot, not us", async () => {
    const user = userEvent.setup();
    class Unsupported {
      static isSupported() {
        return false;
      }
      static readonly Events = { ERROR: "hlsError" } as const;
    }
    renderPanel(liveStream, { hlsLoader: () => Promise.resolve({ default: Unsupported }) });
    await user.click(screen.getByRole("button", { name: /open the live stream/i }));

    // Different remedy, so a different message.
    await waitFor(() =>
      expect(screen.getByText(/neither built-in support nor the Media Source Extensions/i)).toBeInTheDocument(),
    );
  });

  it("reports a fatal stream error instead of leaving a player that never starts", async () => {
    const user = userEvent.setup();
    const { module, record } = fakeHlsModule();
    renderPanel(liveStream, { hlsLoader: () => Promise.resolve(module) });

    await user.click(screen.getByRole("button", { name: /open the live stream/i }));
    await waitFor(() => expect(record.fire).not.toBeNull());
    act(() => record.fire?.());

    // e.g. a CSP block: hls.js raises a fatal error, which must be shown to the reader.
    await waitFor(() =>
      expect(screen.getByText(/stream from stream\.example\.org stopped/i)).toBeInTheDocument(),
    );
  });

  it("offers the manifest URL with an honest warning when there is no source page", async () => {
    const user = userEvent.setup();
    renderPanel(liveStream, { hlsLoader: () => Promise.resolve(null) });
    await user.click(screen.getByRole("button", { name: /open the live stream/i }));

    const link = await screen.findByRole("link", { name: /open the stream URL at/i });
    expect(link.getAttribute("href")).toBe(liveStream.url);
    // Most browsers download an .m3u8 rather than play it.
    expect(screen.getByText(/download the playlist rather than play it/i)).toBeInTheDocument();
  });
});

import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import fintrafficRegistry from "@/content/cameras/fintraffic-digitraffic.json";
import tflRegistry from "@/content/cameras/transport-for-london.json";
import { normaliseCameras } from "@/lib/sources/traffic-cameras";
import type { SourceFeature } from "@/lib/sources/types";
import { FeatureDetail } from "./feature-detail";
import { camerasLayer } from "./registry/cameras";
import { radioLayer } from "./registry/radio";
import type { LayerPayloadDto, MapLayerDefinition } from "./registry";

/**
 * CLICK-TO-LOAD IS A PROMISE ABOUT NETWORK BEHAVIOUR, so it gets tests rather than a comment.
 *
 * ADR 0015: nothing connects to a camera operator or a broadcaster until the reader says so,
 * and the consequence is disclosed in plain words first, naming the host. The most valuable
 * assertion here is the negative one — that **no `<img>` and no `<audio>` exists in the DOM
 * before the press** — because that is the property a future "preload the thumbnail, it feels
 * faster" change would quietly break, and nothing else in this suite would notice.
 *
 * The layers are the real registry entries, so a layer that stops declaring `media`, or starts
 * declaring one whose host disagrees with its URL, fails here.
 */

function payloadFor(layer: MapLayerDefinition): Extract<LayerPayloadDto, { ok: true }> {
  return {
    layerId: layer.id,
    source: {
      slug: layer.sourceSlug,
      name: "Test source",
      homepage: "https://example.org/",
      attribution: { text: "Test credit", licence: "test licence" },
      ttlSeconds: 3600,
    },
    ok: true,
    features: [],
    observedAt: "2026-08-31T00:00:00.000Z",
    stale: false,
  };
}

function renderDetail(layer: MapLayerDefinition, feature: SourceFeature) {
  return render(
    <FeatureDetail layer={layer} feature={feature} payload={payloadFor(layer)} onClose={vi.fn()} />,
  );
}

const cameras = normaliseCameras([tflRegistry, fintrafficRegistry], {});

function radioStation(
  overrides: Record<string, string | number | boolean | null> = {},
): SourceFeature {
  return {
    id: "station-1",
    kind: "radio",
    longitude: 24.94,
    latitude: 60.17,
    label: "Test Station",
    properties: {
      stationUuid: "station-1",
      streamUrl: "https://stream.example.org/live",
      isHls: false,
      isInsecureStream: false,
      codec: "MP3",
      bitrateKbps: 128,
      country: "Finland",
      language: "finnish",
      lastCheckOk: true,
      lastCheckedAt: "2026-08-31T00:00:00.000Z",
      clickCount: 12,
      ...overrides,
    },
  };
}

describe("a camera's image", () => {
  const camera = cameras[0];

  it("has a camera to test with", () => {
    expect(camera).toBeDefined();
  });

  it("makes no outbound request until the reader asks", () => {
    if (!camera) return;
    const { container } = renderDetail(camerasLayer, camera);
    // The element that would issue the request does not exist yet. This is the assertion.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: /load the image/i })).toBeInTheDocument();
  });

  it("names the host in the disclosure and in the control's own label", () => {
    if (!camera) return;
    const host = new URL(String(camera.properties.embedUrl)).host;
    renderDetail(camerasLayer, camera);
    const control = screen.getByRole("button", { name: /load the image/i });
    expect(control.textContent).toContain(host);
    // "IP address" in words, not "we may share some data with third parties".
    expect(screen.getByText(/will see your IP address/i)).toBeInTheDocument();
  });

  it("loads the operator's own URL, with no referrer, once pressed", async () => {
    if (!camera) return;
    const user = userEvent.setup();
    const { container } = renderDetail(camerasLayer, camera);
    await user.click(screen.getByRole("button", { name: /load the image/i }));

    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    // The operator's own host. If this ever became a path on our origin we would be relaying.
    expect(image?.getAttribute("src")).toBe(camera.properties.embedUrl);
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    // An image nobody here can see still needs a name a screen reader can use.
    expect(image?.getAttribute("alt")?.length ?? 0).toBeGreaterThan(20);
  });

  it("renders the credit the licence requires beside the image", async () => {
    if (!camera) return;
    const user = userEvent.setup();
    renderDetail(camerasLayer, camera);
    await user.click(screen.getByRole("button", { name: /load the image/i }));
    expect(screen.getByText(String(camera.properties.attribution))).toBeInTheDocument();
  });

  it("keeps keyboard focus on the control that replaced the one just pressed", async () => {
    if (!camera) return;
    const user = userEvent.setup();
    renderDetail(camerasLayer, camera);
    await user.click(screen.getByRole("button", { name: /load the image/i }));
    // Without this the focused button is removed from the DOM and a keyboard reader lands on
    // <body> mid-panel, with nothing announced — which reads as the press having failed.
    expect(screen.getByRole("button", { name: /disconnect/i })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(screen.getByRole("button", { name: /load the image/i })).toHaveFocus();
  });

  it("offers a way to stop talking to the operator", async () => {
    if (!camera) return;
    const user = userEvent.setup();
    const { container } = renderDetail(camerasLayer, camera);
    await user.click(screen.getByRole("button", { name: /load the image/i }));
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    // Unmounting the element is what actually ends the connection.
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("a radio station's audio", () => {
  it("does not exist in the DOM until the reader presses play", () => {
    const { container } = renderDetail(radioLayer, radioStation());
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.getByRole("button", { name: /play/i })).toBeInTheDocument();
  });

  it("streams from the broadcaster's own URL, never from us", async () => {
    const user = userEvent.setup();
    const { container } = renderDetail(radioLayer, radioStation());
    await user.click(screen.getByRole("button", { name: /play/i }));
    const audio = container.querySelector("audio");
    expect(audio?.getAttribute("src")).toBe("https://stream.example.org/live");
    // `preload="none"` so nothing is fetched by the element's mere existence.
    expect(audio?.getAttribute("preload")).toBe("none");
  });

  it("links out instead of offering a play button that cannot work", () => {
    /*
     * About a fifth of the catalogue publishes plain http, which a browser blocks as mixed
     * content on this page while reporting nothing. A play button there would be a control
     * that silently does nothing; hiding the station would be worse still.
     */
    const { container } = renderDetail(
      radioLayer,
      radioStation({ streamUrl: "http://stream.example.org/live", isInsecureStream: true }),
    );
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("button", { name: /play/i })).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: /open the stream at/i });
    expect(link.getAttribute("href")).toBe("http://stream.example.org/live");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(screen.getByText(/plain http/i)).toBeInTheDocument();
  });

  it("renders no credit for a source whose licence asks for none", async () => {
    const user = userEvent.setup();
    renderDetail(radioLayer, radioStation());
    await user.click(screen.getByRole("button", { name: /play/i }));
    // Radio Browser dedicates the catalogue to the public domain. Inventing a credit line for
    // the station's audio would assert a licence that dedication does not cover.
    expect(screen.queryByText(/licensed under/i)).not.toBeInTheDocument();
  });
});

describe("selecting a different feature", () => {
  it("starts closed again rather than connecting to the next one automatically", async () => {
    const first = cameras[0];
    const second = cameras[1];
    if (!first || !second) return;
    const user = userEvent.setup();
    const { container, rerender } = renderDetail(camerasLayer, first);
    await user.click(screen.getByRole("button", { name: /load the image/i }));
    expect(container.querySelector("img")).not.toBeNull();

    rerender(
      <FeatureDetail
        layer={camerasLayer}
        feature={second}
        payload={payloadFor(camerasLayer)}
        onClose={vi.fn()}
      />,
    );
    // Without the key on the media block React would keep "open", and the reader's browser
    // would contact the second operator without being asked.
    expect(container.querySelector("img")).toBeNull();
  });
});

/**
 * QV-13: the map had no control leading into a case, so the Live pillar and the Workspaces
 * pillar were not joined. QV-14: the design that was written down would have carried the
 * attribution and licence through the browser.
 *
 * The load-bearing assertion is the negative one — that the form carries **only** the source
 * slug and the feature id. Everything else about the snapshot is resolved server-side from
 * the same cache the map was drawn from, and a future "just send the coordinates too, it
 * saves a lookup" change is exactly what this is here to fail.
 */
describe("saving a feature into a case", () => {
  const camera = cameras[0];

  it("offers the control to every reader, signed in or not", () => {
    if (!camera) return;
    renderDetail(camerasLayer, camera);
    const control = screen.getByRole("button", { name: /save to a case/i });
    expect(control).toBeInTheDocument();
    // The label names the feature, because a screen-reader user moving by controls hears it
    // out of context and "save to a case" alone does not say which of them it saves.
    expect(control.textContent).toContain(camera.label);
  });

  it("is a native GET form to a session-gated route, not a scripted button", () => {
    // HANDOFF-directory 1b: a click before hydration does nothing, and a Server Action
    // submitted as a background fetch loses the save if the reader navigates away. A native
    // form has neither window and works with the bundle removed.
    if (!camera) return;
    const { container } = renderDetail(camerasLayer, camera);
    const form = container.querySelector<HTMLFormElement>('form[action="/map/save"]');
    expect(form).not.toBeNull();
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("get");
  });

  it("sends the source slug and the feature id, and nothing else", () => {
    if (!camera) return;
    const { container } = renderDetail(camerasLayer, camera);
    const form = container.querySelector<HTMLFormElement>('form[action="/map/save"]');
    const fields = [...(form?.querySelectorAll("input") ?? [])].map((input) => [
      input.name,
      input.value,
    ]);

    expect(fields).toEqual([
      ["source", camerasLayer.sourceSlug],
      ["feature", camera.id],
    ]);

    // Explicitly: none of the fields a licence obligation could be blanked through.
    const names = fields.map(([name]) => name);
    expect(names).not.toContain("attribution");
    expect(names).not.toContain("licence");
    expect(names).not.toContain("sourceName");
    expect(names).not.toContain("observedAt");
    expect(names).not.toContain("latitude");
  });

  it("does not offer to save a synthetic development layer", () => {
    // The stress harness generates its points in this process. One of them in a case file
    // would be fabricated content in the artefact the reader keeps (product-brief 6).
    if (!camera) return;
    const devLayer: MapLayerDefinition = { ...camerasLayer, devOnly: true };
    render(
      <FeatureDetail
        layer={devLayer}
        feature={camera}
        payload={payloadFor(devLayer)}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /save to a case/i })).not.toBeInTheDocument();
  });
});

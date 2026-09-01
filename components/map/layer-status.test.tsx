import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SourceFailure } from "@/lib/sources/types";
import { LayerStatus, failureSentence } from "./layer-status";
import type { LayerPayloadDto } from "./registry";

/**
 * The degraded states. Carried over from `/live/flights` (ADR 0011 rule 5, ADR 0014) and
 * extended to the six failure kinds `SourceAdapter` actually has.
 *
 * These are tested rather than trusted because they are the states nobody sees during
 * development. QA should be able to break one upstream and find a designed screen, not a
 * blank region — and the specific rules below (no retry after a rate limit, distinct copy per
 * kind) are the ones a later refactor collapses into one generic error box.
 */

const SOURCE = {
  slug: "usgs-earthquakes",
  name: "USGS Earthquake Hazards Program",
  homepage: "https://earthquake.usgs.gov/earthquakes/map/",
  attribution: {
    text: "U.S. Geological Survey",
    href: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
    licence: "public domain (US Government work)",
  },
  ttlSeconds: 60,
};

const FAILURES: readonly SourceFailure[] = [
  { kind: "upstreamError", status: 503, message: "Service Unavailable" },
  { kind: "rateLimited", retryAfterSeconds: 30 },
  { kind: "schemaChanged", message: "expected number, received string" },
  { kind: "timeout", afterMs: 8000 },
  { kind: "notConfigured", missingEnvVar: "USGS_FEED_URL" },
  { kind: "disabled", reason: "the terms are under review." },
];

function failed(failure: SourceFailure): LayerPayloadDto {
  return { layerId: "test", source: SOURCE, ok: false, failure, lastGoodAt: null };
}

function renderStatus(payload: LayerPayloadDto, cadence: "live" | "registry" = "live") {
  const onRetry = vi.fn();
  render(
    <LayerStatus
      label="Earthquakes"
      unavailableTitle="Earthquakes unavailable"
      payload={payload}
      cadence={cadence}
      refreshing={false}
      initialAgeSeconds={12}
      onRetry={onRetry}
    />,
  );
  return { onRetry };
}

describe("failureSentence", () => {
  it("gives every failure kind its own sentence", () => {
    // "It broke" is not a state. Four different things going wrong need four different
    // sentences, and six kinds need six.
    const sentences = FAILURES.map((failure) => failureSentence(failure, "USGS"));
    expect(new Set(sentences).size).toBe(FAILURES.length);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(40);
      expect(sentence.toLowerCase()).not.toContain("something went wrong");
      expect(sentence.toLowerCase()).not.toContain("sorry");
    }
  });

  it("blames our parser, not the upstream, when the schema changed", () => {
    const sentence = failureSentence(
      { kind: "schemaChanged", message: "bad shape" },
      "USGS",
    );
    expect(sentence).toContain("our parser to fix");
  });

  it("says no request was made when the layer is not configured", () => {
    const sentence = failureSentence(
      { kind: "notConfigured", missingEnvVar: "SOME_KEY" },
      "USGS",
    );
    expect(sentence).toContain("SOME_KEY");
    expect(sentence).toContain("no request was made");
  });
});

describe("LayerStatus", () => {
  it("shows the age and the source when the layer is fresh", () => {
    renderStatus({
      layerId: "test",
      source: SOURCE,
      ok: true,
      features: [],
      observedAt: new Date(Date.now() - 12_000).toISOString(),
      stale: false,
    });
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText(/12s ago/)).toBeInTheDocument();
    // Attribution at the point of display, from the adapter, never typed into a component.
    expect(screen.getByText("U.S. Geological Survey")).toBeInTheDocument();
    expect(screen.getByText(/public domain/)).toBeInTheDocument();
  });

  it("marks stale data as stale rather than presenting it as current", () => {
    renderStatus({
      layerId: "test",
      source: SOURCE,
      ok: true,
      features: [],
      observedAt: new Date(Date.now() - 400_000).toISOString(),
      stale: true,
    });
    expect(screen.getByText("Stale")).toBeInTheDocument();
  });

  it("offers a retry when retrying could help", () => {
    renderStatus(failed({ kind: "upstreamError", status: 503, message: "down" }));
    expect(screen.getByRole("button", { name: /retry earthquakes/i })).toBeInTheDocument();
  });

  it("offers NO retry after the upstream asked us to slow down", () => {
    // Not an honesty question but a conduct one: a retry control is an invitation to keep
    // calling a service that has just asked us to stop (product-brief §3.2 constraint 5).
    renderStatus(failed({ kind: "rateLimited", retryAfterSeconds: 30 }));
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("offers no retry for a switched-off layer, a missing config or a schema change", () => {
    for (const failure of FAILURES.filter(
      (f) => f.kind === "disabled" || f.kind === "notConfigured" || f.kind === "schemaChanged",
    )) {
      const { unmount } = render(
        <LayerStatus
          label="Earthquakes"
          unavailableTitle="Earthquakes unavailable"
          payload={failed(failure)}
          cadence="live"
          refreshing={false}
          initialAgeSeconds={null}
          onRetry={vi.fn()}
        />,
      );
      expect(
        screen.queryByRole("button", { name: /retry/i }),
        `${failure.kind} must not offer a retry`,
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("never shows a spinner while refreshing", () => {
    render(
      <LayerStatus
        label="Earthquakes"
        unavailableTitle="Earthquakes unavailable"
        payload={{
          layerId: "test",
          source: SOURCE,
          ok: true,
          features: [],
          observedAt: new Date(Date.now() - 400_000).toISOString(),
          stale: true,
        }}
        cadence="live"
        refreshing
        initialAgeSeconds={400}
        onRetry={vi.fn()}
      />,
    );
    // ADR 0014 §8: the word, never an indeterminate animation that keeps asserting fresh
    // data is arriving after the request has already failed.
    expect(screen.getByText("refreshing")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
});

/**
 * Punctuation, because the run-on it prevents is not cosmetic on this surface.
 *
 * `disabledReason` in `lib/sources/governed.ts` returns a CLAUSE — "an operator switched this
 * source off" — with no full stop, and the first version of the disabled sentence concatenated
 * it straight into the next one: "…switched this source off It stays off until…". A component
 * whose entire job is one distinct, readable sentence per failure cannot ship a run-on, and
 * whoever writes the reason should not have to know how we punctuate it.
 */
describe("the disabled sentence reads as a sentence", () => {
  it("terminates a reason that arrives without a full stop", () => {
    const sentence = failureSentence(
      { kind: "disabled", reason: "an operator switched this source off" },
      "USGS earthquakes",
    );
    expect(sentence).toContain("switched this source off. It stays off");
  });

  it("does not double a full stop on a reason that already has one", () => {
    const sentence = failureSentence(
      { kind: "disabled", reason: "the terms are under review." },
      "USGS earthquakes",
    );
    expect(sentence).not.toContain("..");
  });

  it("does not claim an operator acted when no row ever existed", () => {
    /*
     * `disabledReason` covers four conditions and only one of them is somebody flipping a
     * switch. Opening every one with "we have switched this layer off" was false for the
     * other three — nobody switched off a source that was never registered.
     */
    const sentence = failureSentence(
      { kind: "disabled", reason: "nws-alerts has no registry row, so there is no recorded basis to call it" },
      "NWS active weather alerts",
    );
    expect(sentence).not.toContain("We have switched this layer off");
    expect(sentence).toContain("a decision on our side");
    expect(sentence).toContain("rather than a fault at the source's end");
  });

  it("does not build a possessive out of the source name", () => {
    // "it is not a fault at USGS earthquakes's end" is what a template gets when the source
    // name is a plural noun phrase rather than a company.
    const sentence = failureSentence(
      { kind: "disabled", reason: "an operator switched this source off" },
      "USGS earthquakes",
    );
    expect(sentence).not.toContain("earthquakes's");
    expect(sentence).toContain("fault at the source's end");
  });
});

/**
 * A REGISTRY IS NOT A FEED, AND THE STATUS ROW MUST NOT SAY IT IS.
 *
 * The camera layer's row read `Live · as of 00:00:00 UTC · 26 hours ago`. Both numbers were
 * honest — `observedAt` for a hand-verified list is deliberately the day somebody checked it,
 * because claiming "just now" for a fact checked in August is the freshness lie ADR 0014 exists
 * to prevent — but "Live" was not, and a verification date rendered as an age reads as decay on
 * a surface where every other age means exactly that.
 */
describe("cadence", () => {
  const checked: LayerPayloadDto = {
    layerId: "test",
    source: SOURCE,
    ok: true,
    features: [],
    observedAt: "2026-08-31T00:00:00.000Z",
    stale: false,
  };

  it("says when a registry was checked, and does not call it live", () => {
    renderStatus(checked, "registry");
    expect(screen.getByText("31 August 2026")).toBeInTheDocument();
    expect(screen.getByText("Checked")).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("shows a registry no age at all", () => {
    renderStatus(checked, "registry");
    // "26 hours ago" against a verification date is decay where there is none, and the clock
    // time is 00:00:00 — an artefact of a date, which reads as a stopped clock.
    expect(screen.queryByText(/ago$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/00:00:00/)).not.toBeInTheDocument();
  });

  it("still says 'Live' and shows an age for a feed", () => {
    renderStatus({ ...checked, observedAt: new Date().toISOString() }, "live");
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("says a registry could not be re-read rather than calling it stale", () => {
    renderStatus({ ...checked, stale: true }, "registry");
    // A checked list does not rot. What happened is that we could not re-read it, which is a
    // different fact and the one an operator needs.
    expect(screen.getByText(/could not re-read it/i)).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });
});

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SourceFailure } from "@/lib/sources/types";
import { FAILURE_KINDS } from "./payload";
import { LayerStatus, failureSentence } from "./layer-status";
import type { LayerPayloadDto } from "./registry";

/**
 * Degraded states for every `SourceFailure` kind.
 *
 * Cases are keyed by the union so they can't drift:
 *  1. `Record<SourceFailure["kind"], …>`: a new kind is a compile error here.
 *  2. `Object.keys(CASES)` must equal `FAILURE_KINDS` (from the zod schema in `payload.ts`),
 *     so the schema and the contract must agree too.
 */

/**
 * One case per failure kind: the value, whether a retry is offered, and a phrase the
 * sentence must contain (written out, not derived from the component).
 */
interface FailureCase {
  readonly failure: SourceFailure;
  /** Whether a control is offered. Kept independent of `FAILURE_RETRYABLE`. */
  readonly offersRetry: boolean;
  /** A phrase the reader must actually see, distinctive to this kind. */
  readonly says: RegExp;
}

const CASES: Readonly<Record<SourceFailure["kind"], FailureCase>> = {
  upstreamError: {
    failure: { kind: "upstreamError", status: 503, message: "Service Unavailable" },
    offersRetry: true,
    says: /answered with HTTP 503/,
  },
  rateLimited: {
    // No retry: don't invite calls to a service that asked us to stop.
    failure: { kind: "rateLimited", retryAfterSeconds: 30 },
    offersRetry: false,
    says: /asked us to slow down/,
  },
  quotaExhausted: {
    // Our budget, not the source's, and the sentence must say so.
    failure: { kind: "quotaExhausted", resetsAt: new Date("2026-09-01T09:00:00.000Z") },
    offersRetry: false,
    says: /the limit is ours/i,
  },
  redirected: {
    // Retryable (may be maintenance). Never names the destination host (upstream-controlled).
    failure: { kind: "redirected" },
    offersRetry: true,
    says: /redirecting us to another host/,
  },
  schemaChanged: {
    failure: { kind: "schemaChanged", message: "expected number, received string" },
    offersRetry: false,
    says: /our parser to fix/,
  },
  timeout: {
    failure: { kind: "timeout", afterMs: 8000 },
    offersRetry: true,
    says: /did not answer within 8 seconds/,
  },
  notConfigured: {
    failure: { kind: "notConfigured", missingEnvVar: "USGS_FEED_URL" },
    offersRetry: false,
    says: /no request was made/,
  },
  disabled: {
    failure: { kind: "disabled", reason: "the terms are under review." },
    offersRetry: false,
    says: /a decision on our side/,
  },
};

const FAILURES: readonly SourceFailure[] = FAILURE_KINDS.map((kind) => CASES[kind].failure);

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

describe("the case table covers the union", () => {
  it("has a case for every kind the wire schema accepts, and invents none", () => {
    // Runtime check that the wire schema and the cases agree in both directions.
    expect([...Object.keys(CASES)].sort()).toEqual([...FAILURE_KINDS].sort());
  });

  it("exercises the two kinds that fix rounds added and the old list never mentioned", () => {
    // Guards against passing with an empty table.
    expect(FAILURE_KINDS).toContain("quotaExhausted");
    expect(FAILURE_KINDS).toContain("redirected");
    expect(FAILURES.length).toBeGreaterThanOrEqual(8);
  });
});

describe("failureSentence", () => {
  it("gives every failure kind its own sentence", () => {
    // Each kind needs a distinct sentence.
    const sentences = FAILURES.map((failure) => failureSentence(failure, "USGS"));
    expect(new Set(sentences).size).toBe(FAILURES.length);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(40);
      expect(sentence.toLowerCase()).not.toContain("something went wrong");
      expect(sentence.toLowerCase()).not.toContain("sorry");
    }
  });

  it("says the thing each kind exists to say", () => {
    for (const kind of FAILURE_KINDS) {
      const sentence = failureSentence(CASES[kind].failure, "USGS");
      expect(sentence, `${kind}: ${sentence}`).toMatch(CASES[kind].says);
    }
  });

  it("never names the host of a refused redirect", () => {
    // The destination is upstream-controlled; it goes to the structured log only.
    const sentence = failureSentence({ kind: "redirected" }, "USGS");
    expect(sentence).not.toMatch(/https?:\/\//);
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
    // Attribution comes from the adapter.
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
    // Don't invite calls to a service that asked us to stop.
    renderStatus(failed({ kind: "rateLimited", retryAfterSeconds: 30 }));
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("offers a retry exactly where one can help, for every kind in the union", () => {
    /*
     * No retry for: rate limit (source asked us to stop), spent quota and disabled (retry
     * can't help), schema change (needs a deploy).
     */
    for (const kind of FAILURE_KINDS) {
      const { unmount } = render(
        <LayerStatus
          label="Earthquakes"
          unavailableTitle="Earthquakes unavailable"
          payload={failed(CASES[kind].failure)}
          cadence="live"
          refreshing={false}
          initialAgeSeconds={null}
          onRetry={vi.fn()}
        />,
      );
      const button = screen.queryByRole("button", { name: /retry/i });
      if (CASES[kind].offersRetry) {
        expect(button, `${kind} must offer a retry`).toBeInTheDocument();
      } else {
        expect(button, `${kind} must not offer a retry`).not.toBeInTheDocument();
      }
      unmount();
    }
  });

  it("renders every kind as a designed region rather than a blank one", () => {
    for (const kind of FAILURE_KINDS) {
      const { container, unmount } = render(
        <LayerStatus
          label="Earthquakes"
          unavailableTitle="Earthquakes unavailable"
          payload={failed(CASES[kind].failure)}
          cadence="live"
          refreshing={false}
          initialAgeSeconds={null}
          onRetry={vi.fn()}
        />,
      );
      // Title and icon; an unhandled kind would render a blank row.
      expect(container.textContent ?? "", `${kind} rendered nothing`).toContain(
        "Earthquakes unavailable",
      );
      expect(container.querySelector("svg"), `${kind} has no icon`).not.toBeNull();
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
    // A word, not a spinner.
    expect(screen.getByText("refreshing")).toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
});

/**
 * `disabledReason` (`lib/sources/governed.ts`) returns a clause without a full stop; the
 * sentence must terminate it without doubling one.
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
    // Only one of `disabledReason`'s four conditions is someone flipping a switch.
    const sentence = failureSentence(
      { kind: "disabled", reason: "nws-alerts has no registry row, so there is no recorded basis to call it" },
      "NWS active weather alerts",
    );
    expect(sentence).not.toContain("We have switched this layer off");
    expect(sentence).toContain("a decision on our side");
    expect(sentence).toContain("rather than a fault at the source's end");
  });

  it("does not build a possessive out of the source name", () => {
    // Avoids "USGS earthquakes's end".
    const sentence = failureSentence(
      { kind: "disabled", reason: "an operator switched this source off" },
      "USGS earthquakes",
    );
    expect(sentence).not.toContain("earthquakes's");
    expect(sentence).toContain("fault at the source's end");
  });
});

/**
 * A hand-verified registry isn't a feed: its `observedAt` is the check date, so it shows
 * "Checked <date>" with no "Live" label and no age.
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
    // No age, and no 00:00:00 clock time from a date-only value.
    expect(screen.queryByText(/ago$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/00:00:00/)).not.toBeInTheDocument();
  });

  it("still says 'Live' and shows an age for a feed", () => {
    renderStatus({ ...checked, observedAt: new Date().toISOString() }, "live");
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("says a registry could not be re-read rather than calling it stale", () => {
    renderStatus({ ...checked, stale: true }, "registry");
    // A checked list doesn't go stale; we just couldn't re-read it.
    expect(screen.getByText(/could not re-read it/i)).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });
});

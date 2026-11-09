import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LayerStatus, failureSentence } from "@/components/map/layer-status";
import { layerPayloadSchema } from "@/components/map/payload";
import { fetchUpstream } from "@/lib/sources/http";
import type { SourceFailure } from "@/lib/sources/types";

/**
 * 1. Every `SourceFailure` kind is covered by `components/map/layer-status.test.tsx` and
 *    renders a distinct state.
 * 2. A refused off-host redirect never shows the destination host, checked end to end
 *    through `fetchUpstream`, the client DTO schema and the DOM.
 */

const ALL_KINDS = ["upstreamError", "rateLimited", "quotaExhausted", "redirected", "schemaChanged", "timeout", "notConfigured", "disabled"] as const;

const EVERY_FAILURE: Readonly<Record<(typeof ALL_KINDS)[number], SourceFailure>> = {
  upstreamError: { kind: "upstreamError", status: 503, message: "Service Unavailable" },
  rateLimited: { kind: "rateLimited", retryAfterSeconds: 30 },
  quotaExhausted: { kind: "quotaExhausted", resetsAt: new Date("2026-09-01T09:00:00Z") },
  redirected: { kind: "redirected" },
  schemaChanged: { kind: "schemaChanged", message: "expected number, received string" },
  timeout: { kind: "timeout", afterMs: 8000 },
  notConfigured: { kind: "notConfigured", missingEnvVar: "USGS_FEED_URL" },
  disabled: { kind: "disabled", reason: "the terms are under review." },
};

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

describe("every SourceFailure kind reaches a reader", () => {
  // Checks the source text of layer-status.test.tsx from outside.
  it("the layer-status test cases cover the union, or name what is missing", () => {
    const source = readFileSync(
      join(process.cwd(), "components/map/layer-status.test.tsx"),
      "utf8",
    );
    const covered = ALL_KINDS.filter((kind) => new RegExp(`kind:[ ]*"${kind}"`).test(source));
    expect(
      [...ALL_KINDS].filter((kind) => !covered.includes(kind)),
      "components/map/layer-status.test.tsx drives a hand-written list of failure kinds. " +
        "These members of the SourceFailure union are in no case in that file, so their " +
        "sentence, icon, tone and retry affordance are rendered by nothing.",
    ).toEqual([]);
  });

  it("gives every kind its own distinct sentence", () => {
    const sentences = ALL_KINDS.map((kind) => failureSentence(EVERY_FAILURE[kind], "USGS"));
    expect(new Set(sentences).size).toBe(ALL_KINDS.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20);
  });

  it("renders each kind as a designed state rather than a blank region", () => {
    for (const kind of ALL_KINDS) {
      const { container, unmount } = render(
        <LayerStatus
          label="Earthquakes"
          unavailableTitle="Earthquakes unavailable"
          payload={{ layerId: "test", source: SOURCE, ok: false, failure: EVERY_FAILURE[kind], lastGoodAt: null }}
          cadence="live"
          refreshing={false}
          initialAgeSeconds={12}
          onRetry={vi.fn()}
        />,
      );
      expect((container.textContent ?? "").length, `${kind} renders nothing`).toBeGreaterThan(40);
      unmount();
    }
  });
});

describe("a refused off-host redirect never names the destination", () => {
  it("keeps the attacker-chosen host out of the failure, the DTO and the DOM", async () => {
    const EVIL = "credential-harvest.attacker.example";
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://${EVIL}/steal?q=whistleblower-host` },
        }),
    ) as unknown as typeof fetch;

    try {
      const result = await fetchUpstream({
        slug: "usgs-earthquakes",
        url: "https://earthquake.usgs.gov/feed.geojson",
        signal: AbortSignal.timeout(5000),
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.failure.kind).toBe("redirected");
      expect(JSON.stringify(result.failure)).not.toContain("attacker");

      // Through the wire schema the client parses, then into the DOM.
      const dto = layerPayloadSchema.parse(
        JSON.parse(
          JSON.stringify({ layerId: "test", source: SOURCE, ok: false, failure: result.failure, lastGoodAt: null }),
        ),
      );
      expect(JSON.stringify(dto)).not.toContain("attacker");

      const { container } = render(
        <LayerStatus
          label="Earthquakes"
          unavailableTitle="Earthquakes unavailable"
          payload={dto}
          cadence="live"
          refreshing={false}
          initialAgeSeconds={12}
          onRetry={vi.fn()}
        />,
      );
      expect(container.innerHTML).not.toContain("attacker");
      expect(container.textContent ?? "").toMatch(/redirect/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

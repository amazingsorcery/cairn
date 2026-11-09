import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TOOLBENCH_CONNECTOR_SEEDS } from "@/lib/connectors/toolbench-seeds";
import { SOURCE_CONNECTOR_SEEDS } from "@/lib/sources/connector-seeds";

/**
 * Caddy's `response_header_timeout` must exceed every `connectors.timeout_ms`. Server
 * Actions and route handlers send no headers until done, so the Caddy timeout bounds the
 * whole request; too small and a slow connector becomes a bare 502.
 *
 * Hermetic: reads the Caddyfile and seed constants, no Docker or database.
 */

const CADDYFILE = readFileSync(join(process.cwd(), "infra", "Caddyfile"), "utf8");

/** Room for the audit insert, rate-limit upsert and rendering after the slowest connector. */
const REQUIRED_HEADROOM_MS = 10_000;

/** Every connector row `db/seed.ts` writes from a typed seed, i.e. every governed caller. */
const SEEDS = [...SOURCE_CONNECTOR_SEEDS, ...TOOLBENCH_CONNECTOR_SEEDS];

/**
 * Camera connector rows are built inline in `db/seed.ts`, so read their timeout from source.
 * Nothing calls them today, but include them anyway.
 */
function cameraConnectorTimeoutsMs(): number[] {
  const seedSource = readFileSync(join(process.cwd(), "db", "seed.ts"), "utf8");
  return [...seedSource.matchAll(/timeoutMs:\s*([0-9_]+)/g)].map((match) =>
    Number((match[1] ?? "").replaceAll("_", "")),
  );
}

/** The value on the single `reverse_proxy` branch, in milliseconds. */
function caddyResponseHeaderTimeoutMs(): number {
  const matches = [...CADDYFILE.matchAll(/^\s*response_header_timeout\s+(\d+)(ms|s|m)\s*$/gm)];
  expect(
    matches.length,
    "Expected exactly one uncommented `response_header_timeout` directive in infra/Caddyfile. " +
      "If a second proxy branch was added, this test needs to know which one serves the " +
      "connector-invoking routes.",
  ).toBe(1);

  const [, rawValue, unit] = matches[0] as RegExpMatchArray;
  const value = Number(rawValue);
  if (unit === "ms") return value;
  if (unit === "s") return value * 1000;
  return value * 60_000;
}

describe("infra/Caddyfile response_header_timeout vs connectors.timeout_ms", () => {
  it("finds both sides of the contract at all (guards this test against a refactor)", () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(11);
    expect(cameraConnectorTimeoutsMs().length).toBeGreaterThan(0);
    expect(caddyResponseHeaderTimeoutMs()).toBeGreaterThan(0);
  });

  it("gives every connector room to answer before Caddy gives up", () => {
    const timeouts = [...SEEDS.map((seed) => seed.timeoutMs), ...cameraConnectorTimeoutsMs()];
    const slowest = Math.max(...timeouts);
    const caddy = caddyResponseHeaderTimeoutMs();

    expect(
      caddy,
      `The slowest connector is allowed ${slowest} ms (connectors.timeout_ms), but Caddy gives ` +
        `up after ${caddy} ms. Production would turn that connector's honest "the upstream did ` +
        `not answer in time" into a bare 502 from the proxy, which a reader cannot tell from an ` +
        `empty result. Raise response_header_timeout in infra/Caddyfile to at least ` +
        `${slowest + REQUIRED_HEADROOM_MS} ms, or lower the connector's timeout_ms deliberately ` +
        `and record why.`,
    ).toBeGreaterThanOrEqual(slowest + REQUIRED_HEADROOM_MS);
  });

  it("keeps dial_timeout short, so a dead app still fails fast", () => {
    // A down app is caught by dial_timeout, which must stay short.
    const dial = /^\s*dial_timeout\s+(\d+)s\s*$/m.exec(CADDYFILE);
    expect(dial, "infra/Caddyfile no longer sets dial_timeout").not.toBeNull();
    expect(Number(dial?.[1]), "dial_timeout should stay small; a dead upstream must fail fast").
      toBeLessThanOrEqual(10);
  });

  it("does not route a path that no route handler serves", () => {
    // There is no streaming route, so no stream branch or flush_interval.
    const uncommented = CADDYFILE.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(uncommented).not.toContain("/api/map/stream");
    expect(uncommented).not.toContain("flush_interval");
  });
});

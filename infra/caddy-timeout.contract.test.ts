import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TOOLBENCH_CONNECTOR_SEEDS } from "@/lib/connectors/toolbench-seeds";
import { SOURCE_CONNECTOR_SEEDS } from "@/lib/sources/connector-seeds";

/**
 * `infra/Caddyfile`'s `response_header_timeout` and `connectors.timeout_ms` are a contract,
 * and until QV-12 neither file mentioned the other.
 *
 * WHAT WENT WRONG. Caddy was configured to give up on a response after 30 s. Two connectors
 * — crt.sh and the Internet Archive Wayback Machine — carry `timeout_ms = 40000`. A Server
 * Action sends no response headers until the action returns, and a route handler sends none
 * until it returns a `Response`, so Caddy's `response_header_timeout` bounds the *whole*
 * request rather than only its headers. In production that turned an honest slow success
 * into a bare 502 from the proxy, ten seconds before the connector would have answered.
 *
 * Neither 40 s figure is a preference. `lib/connectors/wayback.ts` records the same CDX
 * query for ripe.net answering in 3.4 s and then 38.3 s on consecutive attempts, and argues
 * that a shorter timeout "would not make the archive faster, it would turn a slow success
 * into a failure the reader cannot distinguish from an empty result". Caddy imposed that
 * shorter timeout anyway.
 *
 * WHY A TEST RATHER THAN A COMMENT. Both numbers are edited by different people for
 * different reasons — one when an upstream is measured, the other when a proxy is tuned —
 * and each edit looks locally correct. The failure is silent and only in production. So the
 * relationship is asserted here, in the one place that reads both.
 *
 * This test is deliberately cheap and hermetic: it reads a file and some exported constants.
 * It needs no Docker, no Caddy and no database, which matters because **nothing in `infra/`
 * has ever been observed running** (`docs/qa/audit-v2.md` §6). It cannot prove Caddy honours
 * the directive; it proves the two numbers we control are consistent, which is the half that
 * was wrong.
 */

const CADDYFILE = readFileSync(join(process.cwd(), "infra", "Caddyfile"), "utf8");

/**
 * Overhead allowed between the slowest connector and Caddy giving up: the audit-log insert,
 * the rate-limit upsert, and rendering the result. Generous on purpose — the cost of a
 * too-large `response_header_timeout` is that a *hung* (not dead) app holds a proxy
 * connection longer, and a dead app is caught by `dial_timeout 5s` instead. The cost of one
 * that is too small is a reader who cannot tell a slow archive from an empty one.
 */
const REQUIRED_HEADROOM_MS = 10_000;

/** Every connector row `db/seed.ts` writes from a typed seed, i.e. every governed caller. */
const SEEDS = [...SOURCE_CONNECTOR_SEEDS, ...TOOLBENCH_CONNECTOR_SEEDS];

/**
 * The camera provider rows are built inline in `db/seed.ts` rather than exported as typed
 * seeds, so they are read out of that file's source instead. There are two of them
 * (`fintraffic-digitraffic` and `transport-for-london`; `link-only-providers` declares
 * `connectorKind: null` and gets no row), they share one literal, and nothing ever calls
 * them — camera embeds are click-to-load from the reader's own browser (ADR 0015). They are
 * included anyway: "nothing calls it" is a property that changes without this file noticing.
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

describe("infra/Caddyfile response_header_timeout vs connectors.timeout_ms (QV-12)", () => {
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
        `and record why. QV-12.`,
    ).toBeGreaterThanOrEqual(slowest + REQUIRED_HEADROOM_MS);
  });

  it("keeps dial_timeout short, so a dead app still fails fast", () => {
    // The two timeouts bound different failures and only one of them should be generous.
    // A refused connection — the app crashed, is restarting, or has not started — is caught
    // by dial_timeout, so raising response_header_timeout above must not make the common
    // "the site is down" case slow to diagnose.
    const dial = /^\s*dial_timeout\s+(\d+)s\s*$/m.exec(CADDYFILE);
    expect(dial, "infra/Caddyfile no longer sets dial_timeout").not.toBeNull();
    expect(Number(dial?.[1]), "dial_timeout should stay small; a dead upstream must fail fast").
      toBeLessThanOrEqual(10);
  });

  it("does not route a path that no route handler serves", () => {
    // QV-07: the Caddyfile carried a `handle` block for /api/map/stream for a route that
    // never existed, and the RUNBOOK handed an operator a curl against it. ADR 0031 removed
    // both. This asserts the config does not grow a branch for an absent route again.
    const uncommented = CADDYFILE.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(uncommented).not.toContain("/api/map/stream");
    expect(uncommented).not.toContain("flush_interval");
  });
});

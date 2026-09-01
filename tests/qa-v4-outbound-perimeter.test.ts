import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * QA v4 — QA-V4-03. The perimeter of `tests/security/outbound-primitive.test.ts`.
 *
 * That test is the structural guard QV-03's fix rests on, and it is a good one: reverting
 * `flights.ts` or `overpass.ts` to a bare `fetch(` turns it red, which I re-measured by
 * adding `lib/connectors/qa-plain.ts`. Its PERIMETER, not its detector, is what fails:
 *
 *   1. `readdirSync` is not recursive and it filters on `entry.isFile()`, so a file in a
 *      SUBDIRECTORY of `lib/connectors/` or `lib/sources/` is never opened. Measured: a
 *      `lib/connectors/drivers/qa-probe.ts` calling `fetch(url, { redirect: "follow" })`
 *      left all 68 assertions green.
 *   2. `FORBIDDEN_IMPORTS` lists HTTP clients and no SOCKET modules, while the test's own
 *      title is "exactly one file per layer may open a socket". Measured: a
 *      `lib/connectors/qa-socket.ts` importing `connect` from `node:net` left it green.
 *
 * This file guards those two, and nothing else — it deliberately does not re-implement the
 * `fetch` detector, which works.
 */

const ROOT = process.cwd();
const LAYERS = ["lib/connectors", "lib/sources"];

/** Present in the repository today and legitimately not a driver. */
const KNOWN_SUBDIRECTORIES = new Set(["lib/sources/__fixtures__"]);

/** Modules that open a socket without going through `fetch` at all. */
const SOCKET_MODULES = ["node:net", "node:tls", "node:dgram", "node:dns", "node:http2"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(`${dir}/${entry.name}`));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(`${dir}/${entry.name}`);
    }
  }
  return out;
}

function subdirectories(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}`);
}

describe("QA-V4-03: the outbound guard's perimeter", () => {
  for (const layer of LAYERS) {
    it(`${layer} is flat, because the guard above it only reads the top level`, () => {
      const unexpected = subdirectories(layer).filter((dir) => !KNOWN_SUBDIRECTORIES.has(dir));
      expect(
        unexpected,
        `tests/security/outbound-primitive.test.ts calls readdirSync on ${layer} without ` +
          `recursion, so nothing in these directories is ever read. Either make that scan ` +
          `recursive or record here why the directory cannot hold an outbound call.`,
      ).toEqual([]);
    });
  }

  it("no file in either layer imports a raw socket module", () => {
    for (const layer of LAYERS) {
      for (const file of walk(layer)) {
        const source = readFileSync(join(ROOT, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
        for (const specifier of SOCKET_MODULES) {
          expect(
            new RegExp(`(?:from|import)[ (]+["']${specifier}["']`).test(source),
            `${file} imports ${specifier}. The byte cap, the host pin and the outbound tally all ` +
              `live in the fetch primitive; a raw socket reaches none of them.`,
          ).toBe(false);
        }
      }
    }
  });

  it("the walk finds the files the guard claims to cover, so this cannot silently empty", () => {
    for (const layer of LAYERS) {
      expect(walk(layer).length).toBeGreaterThan(5);
    }
    expect(walk("lib/connectors").map((f) => relative(ROOT, f).split(sep).join("/"))).toContain(
      "lib/connectors/upstream.ts",
    );
  });
});

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
 *   1. `readdirSync` was not recursive and filtered on `entry.isFile()`, so a file in a
 *      SUBDIRECTORY of `lib/connectors/` or `lib/sources/` was never opened. Measured: a
 *      `lib/connectors/drivers/qa-probe.ts` calling `fetch(url, { redirect: "follow" })`
 *      left all 68 assertions green.
 *
 *      **FIXED, and this file now guards the fix rather than the symptom.** `sourceFiles`
 *      in that test recurses. The assertion here used to be "the layer must stay flat",
 *      which was the right guard while the scan was one level deep and the wrong one the
 *      moment a legitimate subdirectory appeared — `lib/sources/cameras/` holds one camera
 *      provider per operator, none of which may open a socket, and all of which the
 *      recursive scan reads. So what is asserted now is **that the recursion is still
 *      there**: delete it and this turns red, which is the property that actually matters.
 *   2. `FORBIDDEN_IMPORTS` lists HTTP clients and no SOCKET modules, while the test's own
 *      title is "exactly one file per layer may open a socket". Measured: a
 *      `lib/connectors/qa-socket.ts` importing `connect` from `node:net` left it green.
 *
 * This file guards those two, and nothing else — it deliberately does not re-implement the
 * `fetch` detector, which works.
 */

const ROOT = process.cwd();
const LAYERS = ["lib/connectors", "lib/sources"];

/**
 * Subdirectories that exist today, with what each holds.
 *
 * Kept as documentation rather than as a gate: the scan below is recursive, so a directory
 * missing from this set is read anyway. Its value is that a reader can see at a glance what
 * is nested inside the two layers that may reach the network.
 */
const KNOWN_SUBDIRECTORIES: Readonly<Record<string, string>> = {
  "lib/sources/__fixtures__": "captured upstream payloads and a test context; no code path",
  "lib/sources/cameras": "one camera provider per operator; each maps a payload, none fetches",
};

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

const GUARD = "tests/security/outbound-primitive.test.ts";

describe("QA-V4-03: the outbound guard's perimeter", () => {
  it(`${GUARD} still walks subdirectories`, () => {
    /*
     * THE ASSERTION IS ON THE GUARD, NOT ON THE LAYERS. A perimeter that only checks the
     * ground floor is a perimeter with a staircase through it — and the previous shape of
     * this test, "the layer must stay flat", made adding a folder a test failure while
     * leaving the staircase itself unguarded. What must never regress is the recursion.
     */
    const guard = readFileSync(join(ROOT, GUARD), "utf8");
    expect(
      /function sourceFiles\([\s\S]*?sourceFiles\(/.test(guard),
      `${GUARD} no longer recurses into subdirectories, so a driver one folder down opens ` +
        `its own socket unchecked. That is how QV-03, QV-18 and QV-09 reopen at once — not ` +
        `by writing bad code, but by making a folder.`,
    ).toBe(true);
  });

  for (const layer of LAYERS) {
    it(`every subdirectory of ${layer} holds source the guard can read`, () => {
      for (const dir of subdirectories(layer)) {
        const note = KNOWN_SUBDIRECTORIES[dir];
        expect(
          walk(dir).length > 0 || note !== undefined,
          `${dir} is neither scannable source nor recorded in KNOWN_SUBDIRECTORIES. Say what ` +
            `it holds and why it cannot hold an outbound call.`,
        ).toBe(true);
      }
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

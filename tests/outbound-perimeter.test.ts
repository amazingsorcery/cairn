import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards the perimeter of `tests/security/outbound-primitive.test.ts`:
 *   1. its file scan must keep recursing into subdirectories;
 *   2. no file in the network layers imports a raw socket module (that test only checks
 *      HTTP clients).
 * The `fetch` detector itself lives in that test.
 */

const ROOT = process.cwd();
const LAYERS = ["lib/connectors", "lib/sources"];

/** Known subdirectories and what they hold. Documentation only; the scan is recursive. */
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

describe("the outbound guard's perimeter", () => {
  it(`${GUARD} still walks subdirectories`, () => {
    // Asserts on the guard itself: the recursion must not regress.
    const guard = readFileSync(join(ROOT, GUARD), "utf8");
    expect(
      /function sourceFiles\([\s\S]*?sourceFiles\(/.test(guard),
      `${GUARD} no longer recurses into subdirectories, so a driver one folder down could ` +
        `make outbound calls unchecked.`,
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

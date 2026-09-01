import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ONE OUTBOUND PRIMITIVE PER LAYER, ASSERTED AGAINST THE SOURCE TEXT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TEST IS A GREP AND NOT A BEHAVIOURAL TEST
 * ─────────────────────────────────────────────────────────────────────────────
 * QA finding QV-03 was fixed once and reopened, and the reason it reopened is the shape
 * this file exists to end: `readCappedText` was correct, `upstreamGet` and `fetchUpstream`
 * both used it — and `lib/connectors/overpass.ts` and `lib/connectors/flights.ts` called
 * `globalThis.fetch` themselves, so neither the byte cap nor the redirect pin ever applied
 * to them. QA measured 401 MiB pulled on the Overpass path against the 5 MiB the sibling
 * path stops at.
 *
 * A behavioural test cannot state this invariant, because the defect is not a wrong answer:
 * it is a *second route to the socket*. Only the source text says whether a second route
 * exists. QA's own closing note is the argument:
 *
 *   "Four of five closed findings created a correct single source of truth — one predicate,
 *    one helper, one normalisation, one matrix — and in three of them something routes
 *    around it. `isLive` is the exception, and it is the exception because it sits at a
 *    chokepoint every path must cross, rather than being a helper every path is expected to
 *    call."
 *
 * `components/map/registry/index.test.ts` is the precedent: it greps components for layer
 * ids and is why the map registry stayed clean through four new layers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS FORBIDDEN, AND WHAT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * Forbidden, in every file of `lib/connectors/` and `lib/sources/` except the one primitive
 * each layer is allowed:
 *
 *   - calling `fetch(...)`, however it is spelled, including `globalThis.fetch`
 *   - importing an HTTP client that would bypass the primitive (`node:http`, `undici`, …)
 *
 * Not forbidden: DECLARING or CALLING a member named `fetch`. Every driver and every adapter
 * has one — `async fetch(connector, params, signal)` is the interface. The distinction this
 * file draws is between a member named `fetch` and the global function named `fetch`.
 */

const ROOT = process.cwd();

/**
 * The single file in each layer permitted to open a socket, and the reason it is that file.
 *
 * `lib/connectors/upstream.ts` — host-pinned, `redirect: "manual"` with the pin re-applied on
 * every hop, `readCappedText` on the body, `countOutboundRequest()` at each hop. Every
 * connector driver goes through it.
 *
 * `lib/sources/http.ts` — the same three controls for the six map adapters. Two primitives
 * rather than one is a known duplication (QV-18) and is the reason this test names both
 * explicitly rather than counting: a third one appearing is what must fail.
 */
const PERMITTED: Readonly<Record<string, string>> = {
  "lib/connectors": "upstream.ts",
  "lib/sources": "http.ts",
};

/** Modules that would open a socket without going anywhere near the primitive. */
const FORBIDDEN_IMPORTS = [
  "node:http",
  "node:https",
  '"http"',
  '"https"',
  "undici",
  "node-fetch",
  "axios",
  "got",
  "superagent",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Comments and string literals removed, so a `fetch(` inside prose or inside a message
 * cannot be read as a call and a call cannot be hidden inside either.
 *
 * Deliberately crude — it is a lexer for one question, not a parser. Over-removal would make
 * the test miss a call; each replacement below therefore preserves the delimiters and empties
 * only the contents.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "/**/")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

/**
 * Occurrences of the GLOBAL `fetch` being called.
 *
 * Removed first, because they are declarations rather than calls:
 *   - a line whose first token is `fetch`, `async fetch` or `readonly fetch` — a class,
 *     object or interface member. A call never begins a line in this codebase; it is always
 *     `await fetch(`, `= fetch(` or `return fetch(`.
 *   - `.fetch(` — a member call on some receiver (`driver.fetch(`, `adapter.fetch(`).
 *     `globalThis.fetch` and friends are checked separately BEFORE this, since they are the
 *     one member access that is the global.
 */
function globalFetchCalls(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  const hits: string[] = [];

  for (const match of code.matchAll(/\b(?:globalThis|window|global|self)\s*\.\s*fetch\b/g)) {
    hits.push(match[0]);
  }

  const withoutMembers = code
    .replace(/^[ \t]*(?:public\s+|private\s+|readonly\s+)?(?:async\s+)?fetch\s*\(/gm, "")
    .replace(/\.\s*fetch\s*\(/g, ".MEMBER(");

  for (const match of withoutMembers.matchAll(/(^|[^\w$.])fetch\s*\(/g)) {
    hits.push(`${match[1] === "\n" ? "" : match[1]}fetch(`);
  }

  return hits;
}

describe("exactly one file per layer may open a socket", () => {
  for (const [dir, permitted] of Object.entries(PERMITTED)) {
    describe(dir, () => {
      const files = sourceFiles(dir);

      it("has files to check, so this suite cannot silently empty", () => {
        expect(files.length).toBeGreaterThan(5);
        expect(files).toContain(permitted);
      });

      /**
       * The detector is proved against the one file that IS allowed to call `fetch`. Without
       * this, a change that broke `globalFetchCalls` into a function that returns nothing
       * would leave every assertion below green — which is QV-26's defect (a guard that
       * checks its own list rather than the world) reproduced in a security test.
       */
      it(`detects the call in ${permitted}, so a green result means something`, () => {
        const source = readFileSync(join(ROOT, dir, permitted), "utf8");
        expect(globalFetchCalls(source).length).toBeGreaterThan(0);
      });

      for (const file of files.filter((name) => name !== permitted)) {
        it(`${file} does not call the global fetch`, () => {
          const source = readFileSync(join(ROOT, dir, file), "utf8");
          expect(
            globalFetchCalls(source),
            `${dir}/${file} opens its own socket, so the byte cap and the redirect pin in ` +
              `${dir}/${permitted} do not apply to it. That is QV-03.`,
          ).toEqual([]);
        });
      }

      for (const file of files) {
        it(`${file} imports no second HTTP client`, () => {
          const source = stripCommentsAndStrings(readFileSync(join(ROOT, dir, file), "utf8"));
          for (const specifier of FORBIDDEN_IMPORTS) {
            const bare = specifier.replaceAll('"', "");
            expect(
              new RegExp(`from\\s*["']${bare.replace("/", "\\/")}["']`).test(source),
              `${dir}/${file} imports ${bare}`,
            ).toBe(false);
          }
        });
      }
    });
  }
});

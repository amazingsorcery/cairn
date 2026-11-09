import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * One outbound primitive per layer, checked against source text (a second route to the
 * socket isn't a wrong answer, so behavioural tests can't see it).
 *
 * In `lib/connectors/` and `lib/sources/`, only the permitted file may call the global
 * `fetch` or import an HTTP/socket client. Members named `fetch` (the driver/adapter
 * interface) are fine.
 */

const ROOT = process.cwd();

/**
 * The one file per layer allowed to open a socket. Both pin the host, use
 * `redirect: "manual"` re-checked per hop, cap the body with `readCappedText`, and count
 * each request. Named explicitly so a third primitive fails.
 */
const PERMITTED: Readonly<Record<string, string>> = {
  "lib/connectors": "upstream.ts",
  "lib/sources": "http.ts",
};

/** HTTP clients and raw socket modules that would bypass the primitive. */
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
  // Raw sockets.
  "node:net",
  "node:tls",
  "node:dgram",
  '"net"',
  '"tls"',
  '"dgram"',
];

/**
 * Every source file under `dir`, recursively, so subdirectories are covered. Paths are
 * relative to `dir`.
 */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(dir, rel));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Empties comments and string literals (keeping delimiters) so `fetch(` in prose isn't
 * counted. A crude lexer, not a parser.
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
 * Calls to the global `fetch`. Excluded first:
 *   - lines starting with `fetch`/`async fetch`/`readonly fetch` (member declarations; a
 *     real call never starts a line here);
 *   - `.fetch(` member calls. `globalThis.fetch` etc. are matched before this step.
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

      /** Proves the detector works on the file that is allowed to call `fetch`. */
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
              `${dir}/${permitted} do not apply to it.`,
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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EDITOR_NAV, FOOTER_NAV, PRIMARY_NAV, SESSION_NAV } from "@/components/layout/nav-links";

/**
 * Every link in the navigation resolves to a route that exists.
 *
 * The brief's rule is "if it isn't built, it isn't linked", and until now nothing enforced
 * it — the closest thing was a human reading the nav. A dead nav link is the cheapest
 * possible way to look unfinished, and the most likely to survive a refactor that moves a
 * route directory, because moving a directory does not break a string.
 *
 * Dynamic segments are resolved rather than skipped. `/legal/terms` has no directory of its
 * own; it is `app/(public)/legal/[slug]` plus a document. Matching it on the pattern alone
 * would let `/legal/does-not-exist` pass, which is the bug this test is for.
 */

const APP = join(process.cwd(), "app");

/** Route paths that have a `page.tsx`, with route groups `(public)` stripped. */
function routesWithAPage(dir = APP, prefix = ""): { staticPaths: Set<string>; dynamic: string[] } {
  const staticPaths = new Set<string>();
  const dynamic: string[] = [];

  const walk = (current: string, routePrefix: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        // Route groups are organisational and contribute nothing to the URL.
        const segment = /^\(.+\)$/.test(entry) ? "" : `/${entry}`;
        walk(full, `${routePrefix}${segment}`);
      } else if (entry === "page.tsx") {
        const path = routePrefix === "" ? "/" : routePrefix;
        if (path.includes("[")) dynamic.push(path);
        else staticPaths.add(path);
      }
    }
  };

  walk(dir, prefix);
  return { staticPaths, dynamic };
}

/** Slugs a dynamic route can actually serve, read from the same source the route reads. */
function knownSlugs(pattern: string): string[] {
  if (pattern === "/legal/[slug]") {
    return readdirSync(join(process.cwd(), "content", "legal"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }
  return [];
}

const { staticPaths, dynamic } = routesWithAPage();

function resolves(href: string): boolean {
  if (staticPaths.has(href)) return true;
  for (const pattern of dynamic) {
    const parts = pattern.split("/");
    const hrefParts = href.split("/");
    if (parts.length !== hrefParts.length) continue;
    const matches = parts.every((part, i) => part.startsWith("[") || part === hrefParts[i]);
    if (!matches) continue;
    // Matching the shape is not enough — the slug must be one the route can serve.
    const slugs = knownSlugs(pattern);
    if (slugs.length === 0) return true;
    return slugs.includes(hrefParts[hrefParts.length - 1] ?? "");
  }
  return false;
}

describe("navigation links point at routes that exist", () => {
  const groups = [
    ["PRIMARY_NAV", PRIMARY_NAV],
    ["SESSION_NAV", SESSION_NAV],
    ["EDITOR_NAV", EDITOR_NAV],
    ["FOOTER_NAV", FOOTER_NAV],
  ] as const;

  for (const [name, links] of groups) {
    for (const link of links) {
      it(`${name}: ${link.href} resolves`, () => {
        expect(resolves(link.href), `${link.href} is linked from ${name} but no route serves it`).toBe(
          true,
        );
      });
    }
  }

  it("finds the routes at all, so a passing suite is not an empty one", () => {
    // Without this, a bad walk would return no routes, every href would fail, and a
    // well-meaning fix would be to loosen `resolves` rather than to fix the walk.
    expect(staticPaths.size).toBeGreaterThan(20);
    expect(dynamic.length).toBeGreaterThan(3);
  });

  it("rejects a slug the dynamic route cannot serve", () => {
    expect(resolves("/legal/does-not-exist")).toBe(false);
  });
});

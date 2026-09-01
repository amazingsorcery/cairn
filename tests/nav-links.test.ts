import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

/* ------------------------------------------------------------------------------------- *
 * The same rule, one deployment further out.
 * ------------------------------------------------------------------------------------- */

/**
 * A route file existing is not the same as that route being served.
 *
 * In **public-only mode** — no GitHub OAuth and no SMTP, which is how this product can go
 * live with no third-party accounts — `/signin/**` and `/workspaces/**` answer 404. Every
 * one of those routes still has a `page.tsx`, so the walk above cannot see the difference.
 * A link to one of them from a public page is a dead link in exactly the way the brief
 * forbids, and it is invisible on a developer's machine, where a provider is configured.
 *
 * So: a public source file that links to the signed-in surface must also mention the flag
 * that decides whether that surface exists — `isSignInEnabled`, `requireSignInEnabled`, or
 * the `signInEnabled` prop. This is a coarse check and deliberately so. It cannot prove the
 * link is gated correctly; it can prove that whoever added it had to think about the mode,
 * which is the failure that would otherwise ship silently.
 *
 * Adding a genuinely unconditional link here is not blocked — it is made loud.
 */

/** Trees that ARE the signed-in surface. Everything in them is behind a guard already. */
const SIGNED_IN_TREES = [
  join("app", "signin"),
  join("app", "workspaces"),
  join("app", "admin"),
  join("components", "workspaces"),
  join("components", "admin"),
];

/** `href="/workspaces"`, `href={`/workspaces/new…`}`, `action="/map/save"` and friends. */
const LINK_TO_SIGNED_IN = /(?:href|action)=\{?[`"'][^`"']*\/(?:signin|workspaces)\b/;

/** Any of the three names the mode is read under. Matching is case-insensitive so that
 * `isSignInEnabled` and `requireSignInEnabled` both count. */
const MODE_MARKER = /signInEnabled/i;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

describe("public-only mode leaves no dead link", () => {
  const files = [
    ...sourceFiles(join(process.cwd(), "app")),
    ...sourceFiles(join(process.cwd(), "components")),
  ].filter((file) => {
    const rel = relative(process.cwd(), file);
    return !SIGNED_IN_TREES.some((tree) => rel === tree || rel.startsWith(`${tree}${sep}`));
  });

  it("finds the source files at all, so a passing suite is not an empty one", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("gates every public link into the signed-in surface on the mode", () => {
    const ungated = files
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return LINK_TO_SIGNED_IN.test(source) && !MODE_MARKER.test(source);
      })
      .map((file) => relative(process.cwd(), file));

    expect(
      ungated,
      `These files link to /signin or /workspaces without checking whether this deployment ` +
        `has a sign-in at all. In public-only mode each is a dead link:\n  ${ungated.join("\n  ")}`,
    ).toEqual([]);
  });

  it("detects an ungated link when there is one", () => {
    // Without this, a regex that matched nothing would make the assertion above vacuous —
    // which is the shape QA found in several tests in this repository.
    expect(LINK_TO_SIGNED_IN.test('<Link href="/workspaces">your cases</Link>')).toBe(true);
    expect(LINK_TO_SIGNED_IN.test("<form action={`${toolHref}/save`}>")).toBe(false);
    expect(MODE_MARKER.test('<Link href="/workspaces">your cases</Link>')).toBe(false);
  });
});

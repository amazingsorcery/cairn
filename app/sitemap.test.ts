import { describe, expect, it, vi } from "vitest";

/**
 * `sitemap.xml` lists only routes that are actually served.
 *
 * `/signin` and `/workspaces` were already absent, for reasons the route's own header gives.
 * The reason is now stronger rather than different: in public-only mode those routes 404,
 * and a sitemap is a claim to a crawler that the URL exists. This test pins the property so
 * that "the playbook and camera detail URLs are still missing" — which the route header
 * flags as an integration point — cannot be fixed by pasting in the whole route table.
 *
 * The catalogue queries are mocked because the assertion is about which URLs are emitted,
 * not about the database; the real ones are covered by the DB-backed suites.
 */

vi.mock("@/lib/queries/tools", () => ({
  listPublishedToolSlugs: async () => [{ slug: "example-tool", updatedAt: new Date(0) }],
}));

vi.mock("@/lib/queries/taxonomy", () => ({
  listCategorySlugs: async () => ["example-category"],
  listTagSlugs: async () => ["example-tag"],
}));

const sitemap = (await import("./sitemap")).default;

/** Paths that require a session, or that only exist when one can be created. */
const SIGNED_IN_PREFIXES = ["/signin", "/workspaces", "/admin", "/api"];

describe("sitemap", () => {
  it("lists no route that requires a session", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);

    const offenders = paths.filter((path) =>
      SIGNED_IN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
    );
    expect(offenders, `Sitemap lists session-gated routes: ${offenders.join(", ")}`).toEqual([]);
  });

  it("still lists the public surface, so a passing assertion is not an empty one", async () => {
    const paths = (await sitemap()).map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain("/");
    expect(paths).toContain("/directory");
    expect(paths).toContain("/playbooks");
    expect(paths).toContain("/toolbench");
    expect(paths).toContain("/tools/example-tool");
    expect(paths.length).toBeGreaterThan(15);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brand } from "@/config/brand";
import {
  LEGAL_DOCUMENTS,
  UNRESOLVED,
  hasUnresolvedFacts,
  readLegalDocument,
  substituteBrandTokens,
  type LegalDocumentSlug,
} from "./legal";

const slugs = Object.keys(LEGAL_DOCUMENTS) as LegalDocumentSlug[];

describe("substituteBrandTokens", () => {
  it("replaces a known token", () => {
    expect(substituteBrandTokens("Welcome to {{BRAND_NAME}}.")).toBe(`Welcome to ${brand.name}.`);
  });

  it("throws on an unknown token rather than leaking it into a policy", () => {
    expect(() => substituteBrandTokens("Contact {{BRAND_NOT_A_THING}}.")).toThrow(
      /Unknown brand token/,
    );
  });

  it("names every unknown token it found, so one build fixes them all", () => {
    expect(() => substituteBrandTokens("{{AAA}} and {{BBB}}")).toThrow(/AAA, BBB/);
  });

  it("renders an unestablished legal fact as a visible marker, never as prose", () => {
    // Update this test when governing law is actually set in config/brand.ts.
    expect(brand.legal.governingLaw).toBeNull();
    expect(substituteBrandTokens("Governed by {{BRAND_GOVERNING_LAW}}.")).toContain(UNRESOLVED);
  });
});

describe("authored legal documents", () => {
  it("has a file for every declared document", () => {
    const files = readdirSync(join(process.cwd(), "content", "legal"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(files).toEqual([...slugs].sort());
  });

  it.each(slugs)("renders %s with every token resolved", (slug) => {
    const { body } = readLegalDocument(slug);
    expect(body).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it.each(slugs)("never leaves the product name hardcoded in %s", (slug) => {
    const raw = readFileSync(join(process.cwd(), "content", "legal", `${slug}.md`), "utf8");
    // Use {{BRAND_NAME}} so a rename is a one-file change.
    expect(raw).not.toContain(brand.name);
  });

  it.each(slugs)("marks %s as a draft while legal review is outstanding", (slug) => {
    expect(brand.legal.reviewComplete).toBe(false);
    expect(readLegalDocument(slug).isDraft).toBe(true);
  });
});

describe("hasUnresolvedFacts", () => {
  it("detects the marker", () => {
    expect(hasUnresolvedFacts(`Governed by ${UNRESOLVED}.`)).toBe(true);
  });

  it("does not fire on settled text", () => {
    expect(hasUnresolvedFacts("Governed by the laws of Somewhere.")).toBe(false);
  });
});

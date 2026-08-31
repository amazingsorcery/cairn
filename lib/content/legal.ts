import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brand } from "@/config/brand";

/**
 * Renders the authored policy documents in `content/legal/`.
 *
 * The documents are written with `{{PLACEHOLDER}}` tokens instead of literal brand strings,
 * so that renaming the product is a change to `config/brand.ts` alone (product-brief §7).
 *
 * Some of those tokens resolve to facts nobody has established yet — the governing law, the
 * data region, the effective date. Those are `null` in `config/brand.ts` on purpose. This
 * module renders them as a visible marker rather than inventing a plausible value, because
 * a privacy policy that names a jurisdiction we made up is a false statement of fact in the
 * one document a user is entitled to rely on.
 */

export const LEGAL_DOCUMENTS = {
  "acceptable-use": "Acceptable Use Policy",
  privacy: "Privacy Notice",
  terms: "Terms of Service",
  disclaimer: "Disclaimer",
} as const;

export type LegalDocumentSlug = keyof typeof LEGAL_DOCUMENTS;

/** Shown in place of a fact that has not been established. Deliberately conspicuous. */
export const UNRESOLVED = "**[to be confirmed before launch]**";

function resolved(value: string | null): string {
  return value ?? UNRESOLVED;
}

const substitutions: Readonly<Record<string, string>> = {
  BRAND_NAME: brand.name,
  BRAND_DOMAIN: brand.domainPlaceholder,
  BRAND_LEGAL_ENTITY: brand.legalEntity,
  BRAND_CONTACT_PRIVACY: brand.email.privacy,
  BRAND_CONTACT_SECURITY: brand.email.security,
  BRAND_CONTACT_LEGAL: brand.email.legal,
  BRAND_CONTACT_SUPPORT: brand.email.support,
  BRAND_GOVERNING_LAW: resolved(brand.legal.governingLaw),
  BRAND_DATA_REGION: resolved(brand.legal.dataRegion),
  BRAND_CURRENCY: resolved(brand.legal.currency),
  POLICY_EFFECTIVE_DATE: resolved(brand.legal.policyEffectiveDate),
};

const TOKEN = /\{\{([A-Z0-9_]+)\}\}/g;

/**
 * Substitute every `{{TOKEN}}`. Throws on an unknown token rather than leaving it in the
 * output: a user seeing raw `{{BRAND_NAME}}` in a policy is the exact placeholder slop the
 * brief forbids, and failing the build is the only way to guarantee it never ships.
 */
export function substituteBrandTokens(source: string): string {
  const unknown = new Set<string>();
  const output = source.replace(TOKEN, (match, token: string) => {
    const value = substitutions[token];
    if (value === undefined) {
      unknown.add(token);
      return match;
    }
    return value;
  });

  if (unknown.size > 0) {
    throw new Error(
      `Unknown brand token(s) in legal content: ${[...unknown].sort().join(", ")}. ` +
        `Add them to lib/content/legal.ts, or correct the token in content/legal/.`,
    );
  }

  return output;
}

/** True when the document still contains facts nobody has established. */
export function hasUnresolvedFacts(rendered: string): boolean {
  return rendered.includes(UNRESOLVED);
}

export function readLegalDocument(slug: LegalDocumentSlug): {
  title: string;
  body: string;
  isDraft: boolean;
} {
  const raw = readFileSync(join(process.cwd(), "content", "legal", `${slug}.md`), "utf8");
  const body = substituteBrandTokens(raw);
  return {
    title: LEGAL_DOCUMENTS[slug],
    body,
    // A policy is a draft while counsel has not signed it off OR while any fact in it is
    // still unresolved. Both conditions must clear before it reads as settled.
    isDraft: !brand.legal.reviewComplete || hasUnresolvedFacts(body),
  };
}

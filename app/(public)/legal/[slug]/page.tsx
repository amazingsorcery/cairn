import { notFound } from "next/navigation";

import { Markdown } from "@/components/content/markdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { brand } from "@/config/brand";
import { LEGAL_DOCUMENTS, readLegalDocument, UNRESOLVED, type LegalDocumentSlug } from "@/lib/content/legal";
import { pageMetadata } from "@/lib/metadata";
import { formatDate } from "@/lib/utils";

/**
 * `/legal/[slug]` — the policy documents in `content/legal/`.
 *
 * Static at build over `LEGAL_DOCUMENTS` (`docs/architecture/sitemap.md` §5). The documents
 * contain no brand strings: `readLegalDocument()` substitutes every `{{TOKEN}}` from
 * `config/brand.ts` and throws on an unknown one, so an unsubstituted placeholder fails the
 * build instead of shipping into a page a reader is entitled to rely on.
 *
 * THE DRAFT BANNER IS NOT DECORATION. `readLegalDocument()` reports `isDraft` when counsel
 * has not signed off, or when any fact in the document is still unresolved. Both are true
 * today. Facts that nobody has established — the governing law, the data region, the
 * effective date — render as a conspicuous marker rather than as an invented value, because
 * a privacy notice that names a jurisdiction we made up is a false statement of fact in the
 * one document a reader is supposed to be able to trust.
 */

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams(): { slug: LegalDocumentSlug }[] {
  return (Object.keys(LEGAL_DOCUMENTS) as LegalDocumentSlug[]).map((slug) => ({ slug }));
}

function isLegalSlug(slug: string): slug is LegalDocumentSlug {
  return Object.prototype.hasOwnProperty.call(LEGAL_DOCUMENTS, slug);
}

/**
 * Strip the YAML front matter before the body reaches the Markdown renderer.
 *
 * Without this the reader sees the raw `title:` / `slug:` lines and a horizontal rule where
 * the fence was, because remark treats the leading `---` as a thematic break. Written as a
 * regex rather than a YAML parse deliberately: the `yaml` package is a devDependency and
 * pulling a parser into the request path to read four known keys would be the wrong trade.
 */
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** The document's own `# Title`, which this page already renders as the `<h1>`. */
const LEADING_H1 = /^\s*#\s+.*\r?\n+/;

function splitFrontMatter(source: string): { body: string; lastReviewedAt: string | null } {
  const match = FRONT_MATTER.exec(source);
  if (!match) return { body: source.replace(LEADING_H1, ""), lastReviewedAt: null };
  const reviewed = /^lastReviewedAt:\s*"?([0-9]{4}-[0-9]{2}-[0-9]{2})"?\s*$/m.exec(match[1] ?? "");
  return {
    body: source.slice(match[0].length).replace(LEADING_H1, ""),
    lastReviewedAt: reviewed?.[1] ?? null,
  };
}

/**
 * Stop GFM turning a contact address into a `mailto:` link while the domain is unregistered.
 *
 * `remark-gfm` implements autolink literals, so a bare `privacy@…` in the source becomes a
 * live link with no markup asking for one. `brand.domainRegistered` is `false`: the address
 * is on an RFC 2606 reserved TLD that cannot resolve, and the moment a real domain is bought
 * that same string would become a link to a mailbox that may belong to somebody else.
 * `docs/design/states.md` §1.1 and `docs/brand/HANDOFF.md` §1 both say nothing renders as a
 * link while the flag is false.
 *
 * Wrapping in backticks rather than deleting keeps the reader informed: the document still
 * tells them which mailbox a request would go to, and the monospace treatment matches how
 * every other machine-readable identifier is set in this product. The gate is the flag, so
 * the commit that registers the domain turns these back into links with no edit here.
 */
const PLACEHOLDER_ADDRESS = new RegExp(
  String.raw`(?<![\`\w])[\w.+-]+@${brand.domainPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\`\w])`,
  "g",
);

function gateUnregisteredContacts(body: string): string {
  if (brand.domainRegistered) return body;
  return body.replace(PLACEHOLDER_ADDRESS, (address) => `\`${address}\``);
}

export async function generateMetadata({ params }: RouteParams) {
  const { slug } = await params;
  if (!isLegalSlug(slug)) return {};
  const title = LEGAL_DOCUMENTS[slug];
  return pageMetadata({
    title,
    description: `${title}. A pre-launch draft: no qualified lawyer has reviewed it and some facts in it are unconfirmed.`,
    path: `/legal/${slug}`,
    // A draft policy is not something a search engine should be surfacing as settled law.
    index: false,
  });
}

export default async function LegalDocumentPage({ params }: RouteParams) {
  const { slug } = await params;
  if (!isLegalSlug(slug)) notFound();

  const document = readLegalDocument(slug);
  const { body, lastReviewedAt } = splitFrontMatter(document.body);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <article className="mx-auto max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{document.title}</h1>

        {lastReviewedAt ? (
          <p className="tabular mt-2 text-sm text-muted-foreground">
            Last edited{" "}
            <time dateTime={lastReviewedAt}>{formatDate(lastReviewedAt)}</time>
          </p>
        ) : null}

        {document.isDraft ? (
          <Alert variant="warning" className="mt-6">
            <AlertTitle>Draft. No lawyer has read this.</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                This document has not been reviewed by counsel, and the project it describes is
                not an incorporated entity. Facts that nobody has established yet — the
                governing law, where data is held, the date this takes effect — appear in the
                text as {UNRESOLVED.replaceAll("*", "")} rather than as a value we invented.
              </p>
              <p>
                Read it as a statement of intent. Do not rely on it as a binding agreement, and
                do not assume any of it has been checked against the law of your jurisdiction.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        <Markdown className="mt-8">{gateUnregisteredContacts(body)}</Markdown>
      </article>
    </div>
  );
}

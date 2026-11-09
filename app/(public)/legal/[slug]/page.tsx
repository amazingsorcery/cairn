import { notFound } from "next/navigation";

import { Markdown } from "@/components/content/markdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { brand } from "@/config/brand";
import { LEGAL_DOCUMENTS, readLegalDocument, UNRESOLVED, type LegalDocumentSlug } from "@/lib/content/legal";
import { pageMetadata } from "@/lib/metadata";
import { formatDate } from "@/lib/utils";

/**
 * `/legal/[slug]`: policy documents from `content/legal/`, static at build.
 *
 * `readLegalDocument()` substitutes `{{TOKEN}}`s from `config/brand.ts` and throws on unknown
 * ones, so a stray placeholder fails the build. `isDraft` is set when counsel hasn't signed
 * off or any fact is unresolved; unresolved facts render as a visible marker.
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
 * YAML front matter, stripped before rendering (remark would show it as text plus an `<hr>`).
 * A regex because `yaml` is only a devDependency.
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
 * While the domain is unregistered, wrap placeholder addresses in backticks so remark-gfm's
 * autolinking doesn't turn them into `mailto:` links. Flipping `brand.domainRegistered`
 * restores the links.
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

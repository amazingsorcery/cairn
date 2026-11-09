import Link from "next/link";
import { notFound } from "next/navigation";
import { FolderPlus, Scale } from "lucide-react";

import {
  ExternalToolLink,
  InsecureTransportNotice,
  NeedsReviewNotice,
  StaleRecordNotice,
  isStaleRecord,
} from "@/components/directory/entry-notices";
import { costLabel, typeLabel } from "@/components/directory/facets";
import { Markdown } from "@/components/content/markdown";
import {
  ConfidenceChipLink,
  LAST_VERIFIED_ANCHOR,
  RELIABILITY_ANCHOR,
  methodologyAnchorHref,
} from "@/components/layout/methodology-anchor";
import { VerificationDate } from "@/components/verification-date";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { getToolBySlug, listPublishedToolSlugs, type ToolDetail } from "@/lib/queries/tools";
import { pageMetadata } from "@/lib/metadata";
import { isSignInEnabled } from "@/lib/session-surface";
import { cn, displayHost } from "@/lib/utils";
import { staticParamsOrEmpty } from "@/lib/static-params";

/**
 * `/tools/[slug]`: tool detail page. ISR (1h); don't read `searchParams`, `cookies()` or
 * `auth()`. Static params cover published slugs only, and drafts 404.
 *
 * Name, URL, summary, confidence chip and last-verified line stay above the fold. Legal and
 * reliability notes render before the description. Confidence, staleness and insecure
 * transport are separate signals and shown separately.
 *
 * One DOM order: stacked below `xl:`, with the rail moved right at `xl:` via `order`.
 */

export const revalidate = 3600;

interface ToolPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  // Tolerates a build with no database.
  return staticParamsOrEmpty("/tools/[slug]", async () => {
    const rows = await listPublishedToolSlugs();
    return rows.map(({ slug }) => ({ slug }));
  });
}

export async function generateMetadata({ params }: ToolPageProps) {
  const { slug } = await params;
  const tool = await getToolBySlug(slug);
  if (!tool) {
    return pageMetadata({
      title: "Not found",
      description: "",
      path: `/tools/${slug}`,
      index: false,
    });
  }
  return pageMetadata({
    title: tool.name,
    description: tool.summary,
    path: `/tools/${tool.slug}`,
  });
}

/** A labelled section with a consistent heading. Two-level outline: one `h1`, then `h2`s. */
function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className={className}>
      <h2
        id={`${id}-heading`}
        className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
      >
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** One "at a glance" row. Stacks inside the narrow `xl:` rail so long values stay readable. */
function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-2 xl:grid-cols-1">
      <dt className="text-muted-foreground text-sm">{term}</dt>
      <dd className="text-foreground min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** `url · domain · text`, in mono. */
function TypeList({ values }: { values: readonly string[] }) {
  if (values.length === 0) return <span className="text-muted-foreground">not recorded</span>;
  return (
    <ul className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-xs">
      {values.map((value, index) => (
        <li key={value} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {typeLabel(value)}
        </li>
      ))}
    </ul>
  );
}

/** `n/5`, labelled as an editorial rating (there are no user ratings). */
function Reliability({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">not rated</span>;
  return (
    <span className="tabular">
      {value}/5{" "}
      <Link
        href={methodologyAnchorHref(RELIABILITY_ANCHOR)}
        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
      >
        (editorial rating)
      </Link>
    </span>
  );
}

/** Group the flat citation rows by playbook, keeping the query's ordering. */
function groupCitations(citations: ToolDetail["usedInPlaybooks"]) {
  const byPlaybook = new Map<string, { slug: string; title: string; steps: string[] }>();
  for (const citation of citations) {
    const existing = byPlaybook.get(citation.slug);
    if (existing) {
      existing.steps.push(citation.stepTitle);
    } else {
      byPlaybook.set(citation.slug, {
        slug: citation.slug,
        title: citation.title,
        steps: [citation.stepTitle],
      });
    }
  }
  return [...byPlaybook.values()];
}

export default async function ToolPage({ params }: ToolPageProps) {
  const { slug } = await params;
  const tool = await getToolBySlug(slug);
  if (!tool) notFound();

  const stale = isStaleRecord(tool.lastVerifiedAt);
  const toolHref = `/tools/${tool.slug}`;
  const playbooks = groupCitations(tool.usedInPlaybooks);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[
          { label: "directory", href: "/directory" },
          { label: tool.category.name, href: `/directory/${tool.category.slug}` },
          { label: tool.name },
        ]}
      />

      <header className="mt-4 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{tool.name}</h1>

        <p className="mt-2">
          <ExternalToolLink url={tool.url}>{displayHost(tool.url)}</ExternalToolLink>
        </p>

        <p className="text-foreground-secondary mt-3 text-base leading-relaxed md:text-lg">
          {tool.summary}
        </p>

        {/* Chip and last-verified date always sit together. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <ConfidenceChipLink level={tool.confidence} />
          <Link
            href={methodologyAnchorHref(LAST_VERIFIED_ANCHOR)}
            className={cn(
              "rounded-sm underline-offset-4 hover:underline",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            )}
          >
            <VerificationDate lastVerifiedAt={tool.lastVerifiedAt} className="tabular" />
          </Link>
        </div>

        {/* Stale and needs-review are independent, so they're separate notices. */}
        {stale || tool.confidence === "needsReview" ? (
          <div className="mt-5 space-y-4">
            <StaleRecordNotice lastVerifiedAt={tool.lastVerifiedAt} />
            {tool.confidence === "needsReview" ? (
              <NeedsReviewNotice reliabilityNotes={tool.reliabilityNotes} />
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="mt-8 flex flex-col gap-8 xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-10">
        {/* Rail: right column at `xl:`, directly after the header on mobile. */}
        <aside className="space-y-8 xl:sticky xl:top-20 xl:order-2">
          <div className="space-y-3">
            {/*
              Save to a case: shown signed in or out, hidden in public-only mode (where
              `/tools/[slug]/save` 404s). `isSignInEnabled()` is a boot-time constant, so the
              page stays static. A GET form to the dynamic `/save` child, so this page never
              reads the session and needs no JS.
            */}
            {isSignInEnabled() ? (
              <form method="get" action={`${toolHref}/save`}>
                <Button type="submit" size="lg" className="w-full">
                  <FolderPlus aria-hidden="true" />
                  save to a case
                </Button>
              </form>
            ) : null}

            <Button asChild variant="outline" size="lg" className="w-full">
              <a href={tool.url} target="_blank" rel="noopener noreferrer">
                open {displayHost(tool.url)}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </Button>
            {/* Insecure transport is flagged next to the link. */}
            <InsecureTransportNotice url={tool.url} />
          </div>

          <Section id="glance" title="at a glance">
            <dl className="divide-border border-border bg-card divide-y rounded-lg border px-4 py-2">
              <Row term="cost">
                {costLabel(tool.costModel)}
                {tool.costNotes ? (
                  <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
                    {tool.costNotes}
                  </span>
                ) : null}
              </Row>
              <Row term="jurisdiction">
                {tool.jurisdiction ?? <span className="text-muted-foreground">not recorded</span>}
              </Row>
              <Row term="takes">
                <TypeList values={tool.inputTypes} />
              </Row>
              <Row term="gives">
                <TypeList values={tool.outputTypes} />
              </Row>
              <Row term="reliability">
                <Reliability value={tool.reliability} />
              </Row>
              <Row term="category">
                <Link
                  href={`/directory/${tool.category.slug}`}
                  className="hover:text-primary underline underline-offset-4"
                >
                  {tool.category.name}
                </Link>
              </Row>
            </dl>
          </Section>
        </aside>

        <div className="min-w-0 space-y-10 xl:order-1">
          {tool.reliabilityNotes ? (
            <Section id="reliability-notes" title="reliability notes">
              <p className="text-foreground-secondary max-w-[68ch] text-base leading-relaxed">
                {tool.reliabilityNotes}
              </p>
            </Section>
          ) : null}

          {/*
            Legal notes, tinted only when present. A plain section rather than `Alert`, which
            would add `role="alert"` to body copy.
          */}
          {tool.legalNotes ? (
            <section
              aria-labelledby="legal-heading"
              className="border-warning/40 bg-warning-surface rounded-lg border p-5"
            >
              <h2
                id="legal-heading"
                className="text-foreground flex items-center gap-2 text-xs font-semibold tracking-wide uppercase"
              >
                <Scale className="text-warning size-4" aria-hidden="true" />
                legal notes
              </h2>
              <div className="text-foreground mt-3 max-w-[68ch] space-y-3 text-base leading-relaxed">
                {tool.legalNotes.split(/\n{2,}/).map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
              <p className="text-foreground-secondary mt-4 max-w-[68ch] text-sm">
                Listing an entry is not endorsing it. We name what is engaged; we cannot tell you
                what your legal basis is.
              </p>
            </section>
          ) : null}

          <Section id="description" title="description">
            <div className="max-w-[68ch]">
              <Markdown className="text-base">{tool.description}</Markdown>
            </div>
          </Section>

          <Section id="playbooks" title="used in these playbooks">
            {playbooks.length === 0 ? (
              // Not an error; no control needed.
              <p className="text-foreground-secondary text-sm">
                No playbook in the catalogue uses this tool yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {playbooks.map((playbook) => (
                  <li key={playbook.slug}>
                    <Link
                      href={`/playbooks/${playbook.slug}`}
                      className={cn(
                        "border-border bg-card block rounded-md border p-3",
                        "hover:border-foreground-faint hover:bg-accent",
                        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                        "focus-visible:ring-offset-background focus-visible:ring-offset-2",
                      )}
                    >
                      <span className="text-sm font-medium">{playbook.title}</span>
                      <span className="text-muted-foreground mt-1 block text-xs">
                        {playbook.steps.join(" · ")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {tool.tags.length > 0 ? (
            <Section id="tags" title="tags">
              <ul className="flex flex-wrap gap-2">
                {tool.tags.map((tag) => (
                  <li key={tag.slug}>
                    <Link
                      href={`/tags/${tag.slug}`}
                      className={cn(
                        "border-border inline-flex min-h-11 items-center rounded-full border",
                        "bg-card hover:border-foreground-faint hover:bg-accent px-4 text-sm",
                        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                        "focus-visible:ring-offset-background focus-visible:ring-offset-2",
                      )}
                    >
                      {tag.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

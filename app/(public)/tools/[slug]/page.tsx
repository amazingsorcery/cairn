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
 * `/tools/[slug]` — the detail page. This is the page the whole product exists to serve.
 *
 * **ISR:3600** (architecture HANDOFF §8). No `searchParams`, no `cookies()`, no `auth()`.
 * `generateStaticParams` covers **published** slugs only: prerendering a draft slug would
 * publicly confirm that an unpublished entry exists, and `getToolBySlug` filters on
 * `status = 'published'` anyway, so a draft 404s (HANDOFF §7, QA assertion 3).
 *
 * WHAT MUST BE ABOVE THE FOLD, and is — `docs/brand/HANDOFF.md` §7.3 and `states.md` §3.1:
 * the name, the URL in mono, the summary, the confidence chip and the last-verified line. Not
 * behind a tooltip, not in a details panel. They are the product.
 *
 * WHAT MUST NOT BE BURIED: `legalNotes` and `reliabilityNotes`. For several entries — PimEyes
 * above all — the legal notice is the most important content on the page, and it renders
 * immediately after the header, before the description, on a `--warning-surface` tint that
 * appears **only** when the notes are non-empty (`wireframes/03-tool-detail.txt`). It is
 * written as an instrument-naming statement, never as permission and never as advice
 * (`voice.md` rule 3): cataloguing is not endorsing, and a directory that hides the risk is
 * worse than one that omits the entry.
 *
 * THE THREE ORTHOGONAL SIGNALS, which must never be collapsed into one (`states.md` §3.4):
 *   - the confidence chip says how sure we are of what we found;
 *   - the last-verified line says when we last looked;
 *   - the transport badge says the link is plaintext.
 * All three can be true of one entry, in three different colours, icons and page regions.
 *
 * LAYOUT. One DOM order, two shapes. Below `xl:` the sections stack in exactly the 375px
 * wireframe's order — actions, at a glance, reliability notes, legal notes, description, used
 * in, tags. At `xl:` the grid places the main column first and floats the rail to the right,
 * which is the wireframe's desktop shape. `docs/design/wireframes/00-conventions.txt`: the
 * desktop version is the one that gained space, never the one that gained features.
 */

export const revalidate = 3600;

interface ToolPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  // Tolerates a build with no database — see ADR 0018.
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

/**
 * One "at a glance" row.
 *
 * Two columns everywhere except inside the `xl:` rail, which is 20rem wide: a 7rem term
 * column there leaves ~11rem for the value, and `costNotes` is frequently a full sentence.
 * Stacking in the rail keeps the measure readable rather than reflowing prose into a gutter.
 */
function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-2 xl:grid-cols-1">
      <dt className="text-muted-foreground text-sm">{term}</dt>
      <dd className="text-foreground min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** `url · domain · text`, in mono, because these are identifiers and not prose. */
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

/**
 * `states.md` §3.1: rendered exactly as `reliability n/5`, labelled **editorial rating**, and
 * never as a user rating. There is no aggregate and no `reviews` surface (ADR 0010,
 * architecture HANDOFF §9.2).
 */
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

        {/*
          Chip and date sit together, always. `wireframes/00-conventions.txt`: the chip "is
          never the only thing in a row that carries the entry's uncertainty: the last-verified
          line always sits with it." The date links to what the date promises and does not.
        */}
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

        {/*
          Two notices, deliberately separate regions with separate colours and icons. A
          `verified` entry can be stale and a `needsReview` entry can have been checked
          yesterday; both can appear here at once and must still read as two claims.
        */}
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
        {/*
          The rail. `xl:order-2` puts it on the right at 1280px; with no `order` below `xl:`
          it keeps its DOM position, which is the 375px wireframe's order: the outbound link
          and "at a glance" come straight after the header.
        */}
        <aside className="space-y-8 xl:sticky xl:top-20 xl:order-2">
          <div className="space-y-3">
            {/*
              SAVE TO A CASE — the join in the vertical slice (`product-brief.md` §2).

              It renders for EVERYONE, signed in or out. Hiding it from a signed-out reader
              would hide the product's third pillar from exactly the people most likely to want
              it, which is the same reasoning `sitemap.md` §2 gives for the equivalent control
              on `/playbooks/[slug]`.

              THE ONE EXCEPTION IS PUBLIC-ONLY MODE, where no sign-in method is configured, so
              there are no cases to save into and `/tools/[slug]/save` answers 404 (ADR 0032).
              That is not the "signed out" state — signing in is not an option in this
              deployment — and a control whose destination does not exist is the dead link the
              brief forbids. `isSignInEnabled()` reads a constant derived at boot, so this stays
              an ISR page: it reads no cookie, no header and no session.

              A plain GET form, not a client dialog, and that is deliberate: this route is
              ISR:3600 and `sitemap.md` §10.1 forbids a public route reading the session. The
              picker lives at `/tools/[slug]/save`, a `force-dynamic` child segment that can
              read `auth()` without dragging its parent out of static generation. The button
              therefore costs this page no JavaScript at all and still works with the bundle
              removed.
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
            {/* Architecture HANDOFF §9.7 — the transport is stated next to the link. */}
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
            LEGAL NOTES. The `--warning-surface` tint renders only when the notes are
            non-empty (`wireframes/03-tool-detail.txt`), so the colour means something rather
            than decorating every page. This is a plain landmark section, not the `Alert`
            primitive: `Alert` carries `role="alert"`, and a page's most substantial body copy
            is not an alert.

            The heading says "legal notes", not "warning". The notes name the instrument that
            is engaged and say a qualified person must answer it; they never grant or withhold
            permission (`voice.md` rule 3, ADR 0002).
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
              // `states.md` §3.5 — one sentence, no control. Not a failure, not an invitation.
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

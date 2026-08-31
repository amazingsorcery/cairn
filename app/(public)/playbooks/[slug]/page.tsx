import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { PlaybookMeta } from "@/components/playbooks/playbook-meta";
import { PlaybookStep } from "@/components/playbooks/playbook-step";
import { StepNavigator } from "@/components/playbooks/step-navigator";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { VerificationDate } from "@/components/verification-date";
import { Markdown } from "@/components/content/markdown";
import { pageMetadata } from "@/lib/metadata";
import { getPlaybookBySlug, listPublishedPlaybookSlugs } from "@/lib/queries/playbooks";

/**
 * `/playbooks/[slug]` — one method, every step, readable with no account
 * (`docs/brand/HANDOFF.md` §7.4, wireframe 06).
 *
 * ISR:3600 with `generateStaticParams` over PUBLISHED slugs only (architecture HANDOFF §8,
 * sitemap.md §2). A draft slug in the prerender manifest would publicly confirm that an
 * unpublished entry exists. The route reads no `searchParams`, no `cookies()` and no
 * `auth()`; any of those would silently make it dynamic and `revalidate` would do nothing.
 *
 * "start a case from this playbook" renders FOR EVERYONE, signed in or out (sitemap.md §2:
 * hiding it would hide the product's fourth pillar from the people most likely to want it).
 * It is a link to `/workspaces/new?playbook=<slug>`, which is session-gated and redirects a
 * signed-out reader through `/signin` carrying that destination as its `callbackUrl` — so
 * the intent survives the round trip rather than dropping the reader back on a bare page
 * (`docs/design/flows.md` ⚠ W0). See `docs/frontend/HANDOFF-workspaces.md` §3.
 */

export const revalidate = 3600;

export async function generateStaticParams() {
  const slugs = await listPublishedPlaybookSlugs();
  return slugs.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const playbook = await getPlaybookBySlug(slug);
  if (!playbook) {
    return pageMetadata({
      title: "Playbook not found",
      description: "There is no playbook at this address.",
      path: `/playbooks/${slug}`,
      index: false,
    });
  }
  return pageMetadata({
    title: playbook.title,
    description: playbook.summary,
    path: `/playbooks/${playbook.slug}`,
  });
}

export default async function PlaybookDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const playbook = await getPlaybookBySlug(slug);

  // A draft and a slug that never existed are the same answer. Deliberately
  // (`docs/design/states.md` §1.2).
  if (!playbook) notFound();

  const steps = playbook.steps.map((step, index) => ({
    anchor: `step-${index + 1}`,
    title: step.title,
  }));

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[
          { label: "playbooks", href: "/playbooks" },
          // The category is plain text, not a link: `/directory/[category]` is another
          // engineer's route and "if it isn't built, it isn't linked" (product-brief §8).
          // See HANDOFF-workspaces.md §7 for the one-line change when it lands.
          { label: playbook.category.name.toLowerCase() },
          { label: playbook.title },
        ]}
      />

      {/*
        DOM order is h1 → step index → steps, which is both the 375px layout and a legal
        heading outline. From `md` up, explicit grid placement moves the index into a
        sticky left rail spanning both rows without reordering the document: a screen
        reader and a mobile reader meet the h1 first either way.
      */}
      <div className="mt-6 md:grid md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] md:gap-10">
        <header className="md:col-start-2 md:row-start-1">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{playbook.title}</h1>
          <p className="mt-3 max-w-[68ch] text-lg text-foreground-secondary">{playbook.summary}</p>

          <div className="mt-4">
            <PlaybookMeta
              difficulty={playbook.difficulty}
              stepCount={playbook.steps.length}
              estimatedMinutes={playbook.estimatedMinutes}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <ConfidenceChipLink level={playbook.confidence} />
            <VerificationDate lastVerifiedAt={playbook.lastVerifiedAt} />
          </div>

          <Button asChild size="lg" className="mt-6 w-full sm:w-auto">
            <Link href={`/workspaces/new?playbook=${encodeURIComponent(playbook.slug)}`}>
              start a case from this playbook
            </Link>
          </Button>

          {playbook.overview ? (
            <div className="mt-8 max-w-[68ch] border-t border-border pt-8">
              <Markdown className="text-base">{playbook.overview}</Markdown>
            </div>
          ) : null}
        </header>

        <div className="mt-8 md:col-start-1 md:row-span-2 md:row-start-1 md:mt-0 md:self-start">
          <div className="md:sticky md:top-20 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto">
            <StepNavigator steps={steps} />
            <Button asChild variant="outline" className="mt-4 hidden w-full md:inline-flex">
              <Link href={`/workspaces/new?playbook=${encodeURIComponent(playbook.slug)}`}>
                start a case
              </Link>
            </Button>
          </div>
        </div>

        <div className="md:col-start-2 md:row-start-2">
          {playbook.steps.length > 0 ? (
            <div className="mt-10 flex flex-col gap-10">
              {playbook.steps.map((step, index) => (
                <PlaybookStep key={step.id} step={step} position={index + 1} />
              ))}
            </div>
          ) : (
            <p className="mt-10 max-w-[68ch] text-base text-foreground-secondary">
              This playbook has no steps yet. Browse{" "}
              <Link href="/playbooks" className="text-primary underline underline-offset-4">
                the other playbooks
              </Link>{" "}
              in the meantime.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

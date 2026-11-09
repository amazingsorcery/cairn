import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { PlaybookMeta } from "@/components/playbooks/playbook-meta";
import { PlaybookStep } from "@/components/playbooks/playbook-step";
import { StepNavigator } from "@/components/playbooks/step-navigator";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { confidenceMeaning } from "@/components/confidence-chip";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { VerificationDate } from "@/components/verification-date";
import { Markdown } from "@/components/content/markdown";
import { pageMetadata } from "@/lib/metadata";
import { isSignInEnabled } from "@/lib/session-surface";
import { getPlaybookBySlug, listPublishedPlaybookSlugs } from "@/lib/queries/playbooks";
import { staticParamsOrEmpty } from "@/lib/static-params";

/**
 * `/playbooks/[slug]`: one playbook, readable without an account. ISR (1h).
 *
 * Static params cover published slugs only, so the prerender manifest can't reveal drafts.
 * Don't read `searchParams`, `cookies()` or `auth()` or the route turns dynamic.
 *
 * "start a case" shows for signed-out readers too; `/workspaces/new` sends them through
 * `/signin` with a `callbackUrl`. Hidden in public-only mode, where `/workspaces` 404s.
 * `isSignInEnabled()` is a boot-time constant, so the route stays static.
 */

/** A Markdown body's own leading title, which the route already renders as its `h1`. */
const LEADING_HEADING = /^\s*#\s+.*\r?\n+/;

export const revalidate = 3600;

export async function generateStaticParams() {
  // Tolerates a build with no database.
  return staticParamsOrEmpty("/playbooks/[slug]", async () => {
    const slugs = await listPublishedPlaybookSlugs();
    return slugs.map(({ slug }) => ({ slug }));
  });
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

  // Drafts and unknown slugs get the same 404.
  if (!playbook) notFound();

  const steps = playbook.steps.map((step, index) => ({
    anchor: `step-${index + 1}`,
    title: step.title,
  }));

  // Strip the overview's own `# Title`; the page already renders it as the h1.
  const overview = playbook.overview?.replace(LEADING_HEADING, "") ?? null;

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[
          { label: "playbooks", href: "/playbooks" },
          // Category is plain text, not a link.
          { label: playbook.category.name.toLowerCase() },
          { label: playbook.title },
        ]}
      />

      {/*
        DOM order is h1, step index, steps. From `md` up, grid placement moves the index
        into a sticky left rail without reordering the document.
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
          {/*
            Definition comes from `confidenceMeaning()` so it can't drift from the chip. No
            prefix: those strings already open with "Our record of this entry is...".
          */}
          <p className="mt-2 max-w-[68ch] text-sm text-muted-foreground">
            {confidenceMeaning(playbook.confidence)} Every step below is readable without an
            account.
          </p>

          {isSignInEnabled() ? (
            <Button asChild size="lg" className="mt-6 w-full sm:w-auto">
              <Link href={`/workspaces/new?playbook=${encodeURIComponent(playbook.slug)}`}>
                start a case from this playbook
              </Link>
            </Button>
          ) : null}

          {overview ? (
            <div className="mt-8 max-w-[68ch] border-t border-border pt-8">
              <Markdown className="text-base">{overview}</Markdown>
            </div>
          ) : null}
        </header>

        <div className="mt-8 md:col-start-1 md:row-span-2 md:row-start-1 md:mt-0 md:self-start">
          <div className="md:sticky md:top-20 md:max-h-[calc(100dvh-6rem)] md:overflow-y-auto">
            <StepNavigator steps={steps} />
            {isSignInEnabled() ? (
              <Button asChild variant="outline" className="mt-4 hidden w-full md:inline-flex">
                <Link href={`/workspaces/new?playbook=${encodeURIComponent(playbook.slug)}`}>
                  start a case
                </Link>
              </Button>
            ) : null}
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

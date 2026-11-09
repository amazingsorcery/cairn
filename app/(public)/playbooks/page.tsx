import Link from "next/link";

import { PlaybookIndex } from "@/components/playbooks/playbook-index";
import { Button } from "@/components/ui/button";
import {
  LAST_VERIFIED_ANCHOR,
  methodologyAnchorHref,
} from "@/components/layout/methodology-anchor";
import { listPlaybooks } from "@/lib/queries/playbooks";
import { pageMetadata } from "@/lib/metadata";
import { buildSafe } from "@/lib/static-params";

/**
 * `/playbooks`: published listing, ISR (30 min). Don't read `searchParams`, `cookies()` or
 * `auth()` or the route turns dynamic. Filtering is client-side in `PlaybookIndex`.
 */

export const revalidate = 1800;

export const metadata = pageMetadata({
  title: "Playbooks",
  description:
    "Step-by-step investigative methods that use the tools in the directory. Each step states its objective, the tools it uses, and how you know it is done.",
  path: "/playbooks",
});

export default async function PlaybooksPage() {
  // buildSafe returns [] during a build with no DATABASE_URL, and rethrows at runtime so
  // outages reach error.tsx.
  const playbooks = await buildSafe("playbooks-index", () => listPlaybooks(), []);

  // Only categories that have playbooks, so every filter option can match.
  const categories = [
    ...new Map(playbooks.map((p) => [p.categorySlug, { slug: p.categorySlug, name: p.categoryName }])),
  ]
    .map(([, value]) => value)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Playbooks</h1>
      <p className="mt-3 max-w-[68ch] text-lg text-foreground-secondary">
        Step-by-step methods that use the tools in the directory. Each step says what to do
        and how you know it&rsquo;s done.
      </p>
      {/*
        Confidence describes our record of the method, not whether the method is sound.
        Stated once here with a link to the definition, rather than on every card.
      */}
      <p className="mt-2 max-w-[68ch] text-sm text-muted-foreground">
        Each card&rsquo;s confidence level describes our record of that method, not the method
        itself.{" "}
        <Link
          href={methodologyAnchorHref(LAST_VERIFIED_ANCHOR)}
          className="text-primary underline underline-offset-4"
        >
          What the levels and dates promise
        </Link>
        .
      </p>

      {playbooks.length === 0 ? (
        <div className="mt-10 max-w-[68ch] rounded-lg border border-border bg-card p-6">
          <h2 className="text-xl font-semibold tracking-tight">No playbooks published yet</h2>
          <p className="mt-2 text-base leading-relaxed text-foreground-secondary">
            Playbooks are step-by-step methods that use the tools in the directory. Browse the
            directory in the meantime.
          </p>
          <Button asChild className="mt-4 h-11">
            <Link href="/directory">browse the directory</Link>
          </Button>
        </div>
      ) : (
        <PlaybookIndex playbooks={playbooks} categories={categories} />
      )}
    </div>
  );
}

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
 * `/playbooks` — the full published listing.
 *
 * ISR:1800 (architecture HANDOFF §8, sitemap.md §2). The route reads no `searchParams`,
 * no `cookies()` and no `auth()`, which is what keeps `revalidate` meaningful: any one of
 * those would silently make it dynamic and the setting would do nothing.
 *
 * Filtering happens in `PlaybookIndex`, a client leaf, over this prerendered payload.
 * Every other part of the page — heading, lead, metadata — is server-rendered.
 */

export const revalidate = 1800;

export const metadata = pageMetadata({
  title: "Playbooks",
  description:
    "Step-by-step investigative methods that use the tools in the directory. Each step states its objective, the tools it uses, and how you know it is done.",
  path: "/playbooks",
});

export default async function PlaybooksPage() {
  // Prerendered (revalidate 1800) and reads the database, so it must survive a build with
  // no DATABASE_URL — see ADR 0018. buildSafe substitutes the empty list DURING THE BUILD
  // ONLY and rethrows at runtime, so a real outage still reaches error.tsx rather than
  // quietly claiming there are no playbooks.
  const playbooks = await buildSafe("playbooks-index", () => listPlaybooks(), []);

  // Distinct categories, in the order the listing presents them, so the filter offers only
  // values that can actually match something.
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
        The confidence chip on a playbook is the most misreadable element on this page. It
        describes OUR RECORD of the method — whether we have re-checked that its steps and
        its tool references still hold — and not whether the method is sound. Those are
        different claims, and the product's credibility rests on not letting a reader
        collapse them. Said once here rather than on every card, where it would become
        wallpaper — and kept to a POINTER at the definition rather than a second copy of it
        (Q-16). The cards carry mixed levels, so there is no single meaning to render; the
        playbook detail page, which has exactly one, renders `confidenceMeaning()` itself.
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

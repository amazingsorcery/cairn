import Link from "next/link";

import { PlaybookIndex } from "@/components/playbooks/playbook-index";
import { Button } from "@/components/ui/button";
import { listPlaybooks } from "@/lib/queries/playbooks";
import { pageMetadata } from "@/lib/metadata";

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
  const playbooks = await listPlaybooks();

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

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Zero results after filtering: names what is excluding results and offers a way back.
 *
 * `widest` is computed by the page (one query per active filter with that filter dropped).
 * If it's null the suggestion sentence is omitted.
 */
export function EmptyResults({
  activeCount,
  widest,
  clearHref,
}: {
  activeCount: number;
  /** The single removal that widens the result set most, with the count it would yield. */
  widest: { label: string; href: string; total: number } | null;
  clearHref: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold tracking-tight">No tools match these filters</h2>

      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-foreground-secondary">
        {activeCount === 1 ? "1 filter is active." : `${activeCount} filters are active.`}
        {widest ? (
          <>
            {" "}
            Removing {widest.label} widens this the most —{" "}
            <span className="tabular">
              {widest.total === 1 ? "1 tool matches" : `${widest.total} tools match`}
            </span>{" "}
            otherwise.
          </>
        ) : null}
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        {widest ? (
          <Button asChild size="lg">
            <Link href={widest.href}>remove {widest.label}</Link>
          </Button>
        ) : null}
        <Button asChild variant="outline" size="lg">
          <Link href={clearHref}>clear all filters</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * A category or tag with nothing published. Not a 404: the category exists, it's just empty.
 */
export function EmptyCollection({ name, kind }: { name: string; kind: "category" | "tag" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h2 className="text-lg font-semibold tracking-tight">Nothing published in {name} yet</h2>
      <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-foreground-secondary">
        This {kind} exists but has no published entries. Browse the full directory, or search.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href="/directory">browse the directory</Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/search">search</Link>
        </Button>
      </div>
    </div>
  );
}

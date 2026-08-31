import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Zero results after filtering — `docs/design/states.md` §2.1.
 *
 * "This is the state that decides whether the filter bar is usable. It must name what is
 * excluding results and give a one-click way back."
 *
 * `widest` is COMPUTED, never guessed: the page runs the same cached list query once per
 * active filter with that one filter dropped, and passes whichever removal yields the most
 * rows. `voice.md` rule 1 forbids stating a claim without the number that supports it, so if
 * no removal was measured the sentence naming one is not rendered at all — the reader gets
 * the count of active filters and the two controls, and nothing invented.
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
 * A category or tag route with nothing published — `states.md` §2.2.
 *
 * Not a 404. `generateStaticParams` covers every slug, so the route legitimately exists and
 * legitimately has nothing in it; a 404 here would tell the reader the category does not
 * exist, which is a different and untrue claim.
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

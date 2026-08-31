import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";

import { ToolCard, ToolGrid } from "@/components/directory/tool-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { brand } from "@/config/brand";
import { listCameras, listPublishedConnectors } from "@/lib/queries/live";
import { listPlaybooks } from "@/lib/queries/playbooks";
import { listCategories } from "@/lib/queries/taxonomy";
import { listRecentTools, listTools } from "@/lib/queries/tools";
import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";

/**
 * `/` — the front door.
 *
 * **ISR:3600** (architecture HANDOFF §8). Nothing here reads `searchParams`, `cookies()` or
 * `auth()`; the header's signed-in state is upgraded client-side by the shell precisely so
 * this route can stay prerendered (shell handoff §9, sitemap.md §10.1). Adding any of the
 * three would make the `revalidate` below silently meaningless.
 *
 * WHAT THIS PAGE MAY NOT DO — `docs/brand/HANDOFF.md` §7.1 and `states.md` §9.1: no hero
 * banner making a claim about the reader's abilities. It opens with what the thing is.
 *
 * COUNTS ARE READ, NEVER GUESSED. `states.md` §9.1: "If a count cannot be read, the block
 * renders without its number rather than with a zero. A zero we could not verify is a false
 * statement." Every count below is `number | null`, every failure degrades to `null`, and the
 * page never whole-page-errors (§9.3).
 *
 * WHAT THIS PAGE SAYS ABOUT VERIFICATION. `docs/content/verification-log.md` records that of
 * 94 seed entries, 36 were looked up during this build and 58 carry the model knowledge
 * horizon instead. The copy below therefore promises a *dated* record, not a fresh one, and
 * sends the reader to `/methodology` for what the levels mean. Overstating it here would be
 * the one lie this product cannot afford (product-brief §6).
 */

export const revalidate = 3600;

/**
 * Every count is read independently and every failure is contained.
 *
 * `Promise.allSettled`, not `Promise.all`: `states.md` §9.3 requires a failed block to render
 * its description with no count while the rest of the page stays whole. One rejected read must
 * not take the front door down.
 */
async function readCounts() {
  const [tools, categories, playbooks, connectors, cameras, recent] = await Promise.allSettled([
    listTools({
      q: "",
      category: undefined,
      tags: [],
      cost: [],
      input: [],
      output: [],
      confidence: [],
      sort: "name",
      page: 1,
    }),
    listCategories(),
    listPlaybooks(),
    listPublishedConnectors(),
    listCameras({ q: "", jurisdiction: undefined, view: undefined }),
    listRecentTools(6),
  ]);

  for (const settled of [tools, categories, playbooks, connectors, cameras, recent]) {
    if (settled.status === "rejected") {
      logger.warn({ scope: "home", err: settled.reason }, "A home page count could not be read");
    }
  }

  const categoryList = categories.status === "fulfilled" ? categories.value : null;

  return {
    toolTotal: tools.status === "fulfilled" ? tools.value.total : null,
    categories: categoryList === null ? null : categoryList.filter((c) => c.toolCount > 0),
    playbookTotal: playbooks.status === "fulfilled" ? playbooks.value.length : null,
    surfaceTotal: connectors.status === "fulfilled" ? connectors.value.length : null,
    cameraTotal: cameras.status === "fulfilled" ? cameras.value.length : null,
    recent: recent.status === "fulfilled" ? recent.value : [],
  };
}

/** `94 tools`, `1 tool` — or nothing at all when the number could not be read. */
function count(n: number | null, singular: string, plural: string): string | null {
  if (n === null) return null;
  return `${n} ${n === 1 ? singular : plural}`;
}

function join(parts: (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null);
  return present.length > 0 ? present.join(" · ") : null;
}

/**
 * One pillar.
 *
 * `href` is nullable on purpose. `states.md` §9.2: a pillar with nothing published "still
 * renders, saying what the pillar is, without a count and without a link" — product-brief §8's
 * "if it isn't built, it isn't linked" applies to empty as well as to unbuilt.
 */
function Pillar({
  title,
  href,
  description,
  metric,
  cta,
}: {
  title: string;
  href: string | null;
  description: string;
  metric: string | null;
  cta: string;
}) {
  const body = (
    <>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-foreground-secondary">{description}</p>
      <p className="tabular mt-4 flex items-center gap-2 text-sm font-medium text-foreground">
        {metric ?? cta}
        {href ? <ArrowRight className="size-4 shrink-0" aria-hidden="true" /> : null}
      </p>
    </>
  );

  const shape = "flex h-full flex-col rounded-lg border border-border bg-card p-4";

  if (!href) {
    return (
      <li>
        <div className={shape}>
          {body}
          <p className="sr-only">Nothing is published here yet, so there is nothing to open.</p>
        </div>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={href}
        className={cn(
          shape,
          "transition-colors hover:border-foreground-faint hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "motion-reduce:transition-none",
        )}
      >
        {body}
      </Link>
    </li>
  );
}

export default async function HomePage() {
  const data = await readCounts();

  const directoryMetric = join([
    count(data.toolTotal, "tool", "tools"),
    count(data.categories === null ? null : data.categories.length, "category", "categories"),
  ]);
  const liveMetric = join([
    count(data.surfaceTotal, "surface", "surfaces"),
    count(data.cameraTotal, "camera feed", "camera feeds"),
  ]);

  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      {/* No hero claim about the reader. The tagline says what this is. */}
      <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">{brand.tagline}</h1>
      <p className="mt-3 max-w-[68ch] text-base text-foreground-secondary md:text-lg">
        {brand.pitch}
      </p>

      <form role="search" method="get" action="/search" className="mt-6 flex max-w-2xl gap-2">
        <div className="relative flex-1">
          <label htmlFor="home-search" className="sr-only">
            search tools and playbooks
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="home-search"
            name="q"
            type="search"
            autoComplete="off"
            placeholder="search tools and playbooks"
            className="h-11 pl-9"
          />
        </div>
        <Button type="submit" size="lg">
          search
        </Button>
      </form>

      <section aria-labelledby="pillars-heading" className="mt-12">
        <h2 id="pillars-heading" className="sr-only">
          What is here
        </h2>
        <ul className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Pillar
            title="directory"
            href={data.toolTotal === 0 ? null : "/directory"}
            description="Vetted tools and data sources. Every entry states cost, jurisdiction, and when a human last checked it."
            metric={directoryMetric}
            cta="browse the catalogue"
          />
          <Pillar
            title="playbooks"
            href={data.playbookTotal === 0 ? null : "/playbooks"}
            description="Step-by-step methods that use those tools. Each step states its objective and how you know it is done."
            metric={count(data.playbookTotal, "playbook", "playbooks")}
            cta="read the playbooks"
          />
          <Pillar
            title="live"
            href={data.surfaceTotal === 0 ? null : "/live"}
            description="Data operators publish on purpose: open ADS-B aircraft, and official camera feeds. Nothing here is merely reachable."
            metric={liveMetric}
            cta="see what is published"
          />
          <Pillar
            title="workspaces"
            href="/workspaces"
            description="Your own case file: a checklist from a playbook, saved tools, timestamped notes, and an export."
            metric={null}
            cta="sign in to start a case"
          />
        </ul>
      </section>

      {/*
        The honest sentence about the dates. `verification-log.md`: 36 of 94 seed entries were
        looked up during this build and 58 carry the model knowledge horizon. Rather than print
        a number that drifts the moment an editor touches the queue, this says the part that
        stays true — every entry carries its own date, and the dates are not all recent.
      */}
      <section aria-labelledby="dating-heading" className="mt-12 max-w-[68ch]">
        <h2 id="dating-heading" className="text-xl font-semibold tracking-tight">
          What the dates mean
        </h2>
        <p className="mt-3 text-base leading-relaxed text-foreground-secondary">
          Every entry carries the date a human last confirmed it and how sure we are of our own
          record. Not every entry was re-checked in this build: the ones that were not carry an
          earlier date and say so on their own page. The date describes our record, not the
          tool.
        </p>
        <p className="mt-4">
          <Link
            href="/methodology"
            className="font-medium text-primary underline underline-offset-4"
          >
            What each confidence level means
          </Link>
        </p>
      </section>

      {data.categories && data.categories.length > 0 ? (
        <section aria-labelledby="categories-heading" className="mt-12">
          <h2
            id="categories-heading"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            browse by category
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {data.categories.map((category) => (
              <li key={category.slug}>
                <Link
                  href={`/directory/${category.slug}`}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2 rounded-full border border-border",
                    "bg-card px-4 text-sm hover:border-foreground-faint hover:bg-accent",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  )}
                >
                  {category.name}
                  <span className="tabular text-xs text-muted-foreground">
                    {category.toolCount}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.recent.length > 0 ? (
        <section aria-labelledby="recent-heading" className="mt-12">
          <h2 id="recent-heading" className="text-xl font-semibold tracking-tight">
            Recently published entries
          </h2>
          {/*
            `listRecentTools` orders by `published_at DESC` — when the entry went live, not
            when it was last verified. The heading says "published" because that is what the
            query returns; calling it "recently verified" would be a claim the data does not
            support. Each card carries its own last-verified date, which is the number that
            answers the freshness question.
          */}
          <p className="mt-2 text-sm text-foreground-secondary">
            Ordered by when the entry was published. Each card shows when it was last verified.
          </p>
          <div className="mt-4">
            <ToolGrid>
              {data.recent.map((tool) => (
                <li key={tool.id} className="h-full">
                  <ToolCard tool={tool} />
                </li>
              ))}
            </ToolGrid>
          </div>
          <p className="mt-6">
            <Link
              href="/directory"
              className="font-medium text-primary underline underline-offset-4"
            >
              Browse the whole directory
            </Link>
          </p>
        </section>
      ) : null}
    </div>
  );
}

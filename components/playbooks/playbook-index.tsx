"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DIFFICULTY_LEVELS, type DifficultyLevel } from "@/db/schema";
import type { PlaybookCard } from "@/lib/queries/playbooks";
import { cn } from "@/lib/utils";
import { PlaybookCardItem } from "./playbook-card";

/**
 * `/playbooks` — the whole published listing, filtered in the browser.
 *
 * WHY THE FILTER IS CLIENT-SIDE (`docs/architecture/sitemap.md` §2, wireframe 05): the
 * playbook count is two orders of magnitude below the tool count, so the entire payload is
 * prerendered and filtering hides rows. Reading `searchParams` here would opt the route out
 * of the Full Route Cache and buy nothing.
 *
 * This is the ONLY client component on the route, and it is a leaf: the page heading, the
 * lead paragraph and the metadata are all rendered on the server.
 *
 * Consequences that follow from filtering never leaving the route:
 *   - there is no loading state after first paint and no error state at all here, because
 *     there is no round trip to fail (wireframe 05);
 *   - focus is never moved on a filter change. The reader is still in the filter bar; the
 *     new count is announced in the route's one live region instead (HANDOFF-shell §10.1).
 */

const ANY = "any";

export interface PlaybookIndexProps {
  playbooks: readonly PlaybookCard[];
  /** Distinct category slugs and names, derived on the server so the order is stable. */
  categories: readonly { slug: string; name: string }[];
}

export function PlaybookIndex({ playbooks, categories }: PlaybookIndexProps) {
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState<DifficultyLevel | typeof ANY>(ANY);
  const [category, setCategory] = useState<string>(ANY);

  const queryId = useId();
  const difficultyId = useId();
  const categoryId = useId();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return playbooks.filter((playbook) => {
      if (needle && !playbook.title.toLowerCase().includes(needle)) return false;
      if (difficulty !== ANY && playbook.difficulty !== difficulty) return false;
      if (category !== ANY && playbook.categorySlug !== category) return false;
      return true;
    });
  }, [playbooks, query, difficulty, category]);

  const isFiltered = query.trim() !== "" || difficulty !== ANY || category !== ANY;

  function clearFilter() {
    setQuery("");
    setDifficulty(ANY);
    setCategory(ANY);
  }

  const selectClass = cn(
    "h-11 w-full rounded-md border border-input bg-background px-3 text-sm",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  );

  return (
    <>
      <div className="mt-8 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={queryId}>filter by title</Label>
          <div className="relative">
            <Input
              id={queryId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="filter by title"
              autoComplete="off"
              className="h-11 pr-11"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-0 top-0 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden="true" />
                <span className="sr-only">clear the title filter</span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={difficultyId}>difficulty</Label>
          <select
            id={difficultyId}
            className={selectClass}
            value={difficulty}
            onChange={(event) =>
              setDifficulty(event.target.value as DifficultyLevel | typeof ANY)
            }
          >
            <option value={ANY}>any</option>
            {DIFFICULTY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={categoryId}>category</Label>
          <select
            id={categoryId}
            className={selectClass}
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value={ANY}>any</option>
            {categories.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <p className="tabular text-sm text-foreground-secondary md:pb-3">
          {filtered.length === 1 ? "1 playbook" : `${filtered.length} playbooks`}
        </p>
      </div>

      {/*
        The route's single polite live region. It is in the DOM before any filtering
        happens, because a live region created at the same moment as its content announces
        nothing (HANDOFF-shell §10.1).
      */}
      <p aria-live="polite" className="sr-only">
        {filtered.length === 1
          ? "1 playbook matches these filters"
          : `${filtered.length} playbooks match these filters`}
      </p>

      {filtered.length === 0 ? (
        <div className="mt-10 rounded-lg border border-border bg-card p-6">
          <h2 className="text-xl font-semibold tracking-tight">No playbooks match that filter</h2>
          <p className="mt-2 text-base leading-relaxed text-foreground-secondary">
            Clear the filter to see all {playbooks.length}.
          </p>
          <Button onClick={clearFilter} className="mt-4 h-11">
            clear filter
          </Button>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {filtered.map((playbook) => (
            <li key={playbook.id}>
              <PlaybookCardItem playbook={playbook} />
            </li>
          ))}
        </ul>
      )}

      {isFiltered && filtered.length > 0 ? (
        <p className="mt-6 text-sm text-foreground-secondary">
          <Button variant="link" onClick={clearFilter} className="h-11 px-0">
            clear filter
          </Button>{" "}
          to see all {playbooks.length}, or{" "}
          <Link href="/directory" className="text-primary underline underline-offset-4">
            browse the directory
          </Link>
          .
        </p>
      ) : null}
    </>
  );
}

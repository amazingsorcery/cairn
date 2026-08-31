"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The search field with type-ahead. `docs/design/wireframes/04-search.txt`.
 *
 * The field is a real `<input name="q">` inside a real `<form method="get" action="/search">`,
 * so search works with the bundle removed and every result page is a shareable URL. The
 * suggestion list is an enhancement layered on top; it never becomes the only way to search.
 *
 * PRIVACY, which is why this endpoint exists at all rather than a prefetched index:
 * `/api/search/suggest` is `private, no-store` at every layer (`caching.md` §7). A shared
 * cache of partial queries, keyed by prefix and warmed by whoever typed first, is a readable
 * log of what this audience is looking into — product-brief §3.2 constraint 4 covers our own
 * infrastructure, not only third-party trackers. Nothing here prefetches, and the request is
 * only made after the reader stops typing.
 *
 * RATE LIMITING, `states.md` §2.7: when the limiter bites, the list is replaced by one row of
 * text and **the field is never disabled**. Submitting the query is a different endpoint and
 * it still works. Disabling the input would take away the thing that still functions.
 *
 * ACCESSIBILITY. ARIA 1.2 combobox: `role="combobox"` with `aria-expanded`, `aria-controls`
 * and `aria-activedescendant` on the input, `role="listbox"` on the list, `role="option"` on
 * the rows. Arrow keys move the active option without moving DOM focus, Enter opens the
 * active one, and Escape closes the list and leaves focus in the field — never on the page
 * body, which is where a naive `blur()` would strand a keyboard reader.
 */

interface Suggestion {
  slug: string;
  name: string;
}

const LISTBOX_ID = "search-suggestions";
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

export function SearchField({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [query, setQuery] = React.useState(initialQuery);
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  /** Seconds until suggestions resume, from the endpoint's `Retry-After`. */
  const [pausedFor, setPausedFor] = React.useState<number | null>(null);
  /**
   * Has the reader actually typed in this field?
   *
   * Without this, arriving at `/search?q=certificate+transparency` fires the suggestion
   * effect from the initial value and drops a listbox over the results the reader just asked
   * for. Suggestions are a response to typing, not to landing on a page — so the effect still
   * runs, but it may only OPEN the list once the field has been edited.
   */
  const typed = React.useRef(false);

  // Re-sync when the URL changes underneath us — a browser back, or a suggestion opened and
  // then dismissed. Without this the field keeps text for a search that is no longer showing.
  React.useEffect(() => {
    setQuery(initialQuery);
    typed.current = false;
    setOpen(false);
  }, [initialQuery]);

  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(trimmed)}`, {
            signal: controller.signal,
            cache: "no-store",
          });

          if (response.status === 429) {
            const retryAfter = Number(response.headers.get("Retry-After") ?? "30");
            setPausedFor(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
            setSuggestions([]);
            setOpen(typed.current);
            return;
          }

          if (!response.ok) {
            // A failed suggestion is not an error the reader needs to see: the field still
            // submits. Close the list and say nothing.
            setSuggestions([]);
            setOpen(false);
            return;
          }

          const body: unknown = await response.json();
          const results =
            typeof body === "object" && body !== null && "results" in body
              ? (body as { results: unknown }).results
              : [];
          const parsed = Array.isArray(results)
            ? results.filter(
                (row): row is Suggestion =>
                  typeof row === "object" &&
                  row !== null &&
                  typeof (row as Suggestion).slug === "string" &&
                  typeof (row as Suggestion).name === "string",
              )
            : [];

          setPausedFor(null);
          setSuggestions(parsed);
          setActive(-1);
          setOpen(typed.current && parsed.length > 0);
        } catch {
          // Aborted or offline. Silence is correct: the form still works.
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function openSuggestion(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    close();
    router.push(`/tools/${suggestion.slug}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // Close, and leave focus exactly where it was. The wireframe calls this out.
      close();
      inputRef.current?.focus();
      return;
    }
    if (!open || suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === "Enter" && active >= 0) {
      // Only intercept Enter when an option is actually highlighted. Otherwise the form
      // submits and the reader gets the full result page, which is what Enter usually means.
      event.preventDefault();
      openSuggestion(active);
    }
  }

  const activeId = active >= 0 && suggestions[active] ? `suggestion-${suggestions[active].slug}` : undefined;

  return (
    <form role="search" method="get" action="/search" className="relative">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <label htmlFor="search-q" className="sr-only">
            search tools and playbooks
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            id="search-q"
            name="q"
            type="search"
            role="combobox"
            autoComplete="off"
            aria-expanded={open}
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            {...(activeId ? { "aria-activedescendant": activeId } : {})}
            placeholder="search tools and playbooks"
            value={query}
            onChange={(event) => {
              typed.current = true;
              setQuery(event.currentTarget.value);
            }}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              // Leaving the field for anything outside the listbox closes it. Clicking a row
              // is handled by `onMouseDown` below, which fires first.
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) close();
            }}
            className={cn(
              "flex h-11 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm",
              "placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          />

          <ul
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Suggestions"
            className={cn(
              "absolute left-0 right-0 top-full z-[var(--z-dropdown)] mt-1 overflow-hidden",
              "rounded-md border border-border bg-popover text-popover-foreground shadow-md",
              !open && "hidden",
            )}
          >
            {pausedFor !== null ? (
              <li className="px-3 py-3 text-sm text-muted-foreground">
                Too many requests. Suggestions pause for {pausedFor} seconds; the search box
                still works.
              </li>
            ) : (
              suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.slug}
                  id={`suggestion-${suggestion.slug}`}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    openSuggestion(index);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 text-sm",
                    index === active && "bg-accent text-accent-foreground",
                  )}
                >
                  <span className="truncate">{suggestion.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">tool</span>
                </li>
              ))
            )}
          </ul>
        </div>

        <Button type="submit" size="lg">
          search
        </Button>
      </div>
    </form>
  );
}

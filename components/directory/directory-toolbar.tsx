import { Search } from "lucide-react";

import { SORT_OPTIONS } from "./facets";
import { FilterForm, FilterTextInput, SortSelect } from "./filter-controls";

/**
 * The row above the results: filter-by-name and sort.
 *
 * It is a second `<form method="get">`, separate from the facet panel, so each can be
 * submitted on its own. That means each must mirror the other's state as hidden inputs — a
 * GET form submits only what it contains, so a toolbar without the facet mirror would clear
 * every checkbox the moment the reader pressed Enter in the name field.
 *
 * The name field submits on Enter, not on every keystroke. Debounced search-as-you-type here
 * would push a history entry per character, which would make the back button — the control
 * this route is built around — useless.
 */
export function DirectoryToolbar({
  action,
  q,
  sort,
  hidden,
  sheet,
}: {
  action: string;
  q: string;
  sort: string;
  hidden: readonly { name: string; value: string }[];
  /** The mobile filter trigger, rendered inside the toolbar row at 375px. */
  sheet?: React.ReactNode;
}) {
  return (
    <FilterForm action={action} className="flex flex-col gap-3 sm:flex-row sm:items-center">
      {hidden.map((pair, index) => (
        <input key={`${pair.name}-${pair.value}-${index}`} type="hidden" {...pair} />
      ))}

      <div className="relative flex-1">
        <label htmlFor="directory-q" className="sr-only">
          filter by name
        </label>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <FilterTextInput
          id="directory-q"
          name="q"
          value={q}
          placeholder="filter by name"
          className="pl-9"
        />
      </div>

      <div className="flex items-center gap-3">
        {sheet ? <div className="md:hidden">{sheet}</div> : null}
        <label htmlFor="directory-sort" className="sr-only">
          sort order
        </label>
        <SortSelect id="directory-sort" value={sort} options={SORT_OPTIONS} />
      </div>
    </FilterForm>
  );
}

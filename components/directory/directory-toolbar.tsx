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
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <FilterTextInput
          id="directory-q"
          name="q"
          value={q}
          placeholder="filter by name"
          className="pl-9"
        />
      </div>

      {/*
        THE FORM NEEDS A SUBMIT BUTTON, and not only for the no-JavaScript path.

        HTML implicit submission — pressing Enter in a text field — only fires when the form
        has a submit button, or when it has exactly one field that blocks implicit submission.
        This form has the name field, a `type="button"` sheet trigger and a `<select>`, and
        Chrome declines to submit it. Without this button, Enter in the name field did nothing
        at all: the filter looked broken to anyone who did not think to click elsewhere, and
        there was no keyboard route to submitting it with the bundle removed.

        `sr-only` until focused, because the wireframe draws no visible button beside the field
        at either width — but a control nobody can reach is the same as no control at all, so
        it becomes visible the moment it is tabbed to.
      */}
      <button
        type="submit"
        className="focus:border-input sr-only focus:not-sr-only focus:inline-flex focus:h-11 focus:items-center focus:rounded-md focus:border focus:px-4 focus:text-sm focus:font-medium"
      >
        apply the name filter
      </button>

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

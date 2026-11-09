import { Search } from "lucide-react";

import { SORT_OPTIONS } from "./facets";
import { FilterForm, FilterTextInput, SortSelect } from "./filter-controls";

/**
 * Name filter and sort, as a GET form separate from the facet panel; `hidden` mirrors the
 * facet state so submitting here doesn't clear it. Submits on Enter, not per keystroke,
 * to avoid a history entry per character.
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
        Required for Enter to submit: implicit submission needs a submit button when the form
        has more than one field. Visually hidden until focused.
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

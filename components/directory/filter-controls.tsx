"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Client side of the directory filters.
 *
 * Controls sit in a GET form that produces the URL shape `parseDirectoryFilters` reads, so
 * filters work without JS. With JS, `submit()` does a `router.push` of the same URL inside a
 * transition.
 *
 * Pending state is in a context so `ResultsRegion` (wrapping Server Component results) can
 * set `aria-busy`. Focus is not moved on filter change.
 */

interface FilterContextValue {
  pending: boolean;
  submit: (form: HTMLFormElement) => void;
}

const FilterContext = React.createContext<FilterContextValue | null>(null);

function useFilterContext(): FilterContextValue {
  const value = React.useContext(FilterContext);
  if (!value) {
    throw new Error("Directory filter controls must be rendered inside <DirectoryFilters>.");
  }
  return value;
}

/**
 * The URL a GET submission would produce, minus empty values like bare `?q=`. Built from
 * `FormData`, not component state.
 */
function formHref(form: HTMLFormElement, action: string): string {
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form).entries()) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    params.append(name, trimmed);
  }
  const query = params.toString();
  return query ? `${action}?${query}` : action;
}

export function DirectoryFilters({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const submit = React.useCallback(
    (form: HTMLFormElement) => {
      const action = form.getAttribute("action") ?? "/directory";
      const href = formHref(form, action);
      // Keep scroll position in the facet list.
      startTransition(() => router.push(href, { scroll: false }));
    },
    [router],
  );

  const value = React.useMemo(() => ({ pending, submit }), [pending, submit]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

/** The filter form. `action` is used by both the no-JS submit and `router.push`. */
export function FilterForm({
  action,
  className,
  children,
  ...rest
}: {
  action: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.FormHTMLAttributes<HTMLFormElement>, "action" | "method" | "onSubmit">) {
  const { submit } = useFilterContext();

  return (
    <form
      method="get"
      action={action}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
      {...rest}
    >
      {children}
    </form>
  );
}

/**
 * Name filter. Controlled, re-synced from the URL (chip removal, clear all, back). Submits
 * on Enter only, so history isn't flooded with one entry per keystroke.
 */
export function FilterTextInput({
  id,
  name,
  value,
  placeholder,
  className,
}: {
  id: string;
  name: string;
  value: string;
  placeholder: string;
  className?: string;
}) {
  const [current, setCurrent] = React.useState(value);

  React.useEffect(() => {
    setCurrent(value);
  }, [value]);

  return (
    <input
      id={id}
      name={name}
      type="search"
      value={current}
      autoComplete="off"
      placeholder={placeholder}
      onChange={(event) => setCurrent(event.currentTarget.value)}
      className={cn(
        "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    />
  );
}

/**
 * Facet checkbox. Local state gives instant feedback during the transition; the effect
 * re-syncs when the URL changes elsewhere (back, chip removal, clear all).
 */
export function FacetCheckbox({
  id,
  name,
  value,
  checked,
  count,
  children,
}: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  /** `null` when the facet-count query has nothing for this value. */
  count: number | null;
  children: React.ReactNode;
}) {
  const { submit } = useFilterContext();
  const [on, setOn] = React.useState(checked);

  React.useEffect(() => {
    setOn(checked);
  }, [checked]);

  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-sm",
        "hover:bg-accent hover:text-accent-foreground",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
        "motion-reduce:transition-none",
      )}
    >
      <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
        <input
          id={id}
          name={name}
          value={value}
          type="checkbox"
          checked={on}
          onChange={(event) => {
            setOn(event.currentTarget.checked);
            const form = event.currentTarget.form;
            if (form) submit(form);
          }}
          className={cn(
            "peer absolute inset-0 size-5 cursor-pointer appearance-none rounded border border-input",
            "checked:border-primary checked:bg-primary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        />
        <Check
          aria-hidden="true"
          className="pointer-events-none size-3.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
        />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
      {count === null ? null : (
        <span className="tabular shrink-0 text-xs text-muted-foreground">{count}</span>
      )}
    </label>
  );
}

/** Facet radio, for `category`, which `parseDirectoryFilters` reads as a single value. */
export function FacetRadio({
  id,
  name,
  value,
  checked,
  count,
  children,
}: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  count: number | null;
  children: React.ReactNode;
}) {
  const { submit } = useFilterContext();
  const [selected, setSelected] = React.useState(checked);

  React.useEffect(() => {
    setSelected(checked);
  }, [checked]);

  return (
    <label
      htmlFor={id}
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-sm",
        "hover:bg-accent hover:text-accent-foreground",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
      )}
    >
      <input
        id={id}
        name={name}
        value={value}
        type="radio"
        checked={selected}
        onChange={(event) => {
          setSelected(event.currentTarget.checked);
          const form = event.currentTarget.form;
          if (form) submit(form);
        }}
        className={cn(
          "size-5 shrink-0 cursor-pointer appearance-none rounded-full border border-input",
          "checked:border-[6px] checked:border-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      />
      <span className="min-w-0 flex-1">{children}</span>
      {count === null ? null : (
        <span className="tabular shrink-0 text-xs text-muted-foreground">{count}</span>
      )}
    </label>
  );
}

/** Sort control. Native `<select>` so it submits in the GET form without JS. */
export function SortSelect({
  id,
  value,
  options,
}: {
  id: string;
  value: string;
  options: readonly { value: string; label: string }[];
}) {
  const { submit } = useFilterContext();
  const [current, setCurrent] = React.useState(value);

  React.useEffect(() => {
    setCurrent(value);
  }, [value]);

  return (
    <select
      id={id}
      name="sort"
      value={current}
      onChange={(event) => {
        setCurrent(event.currentTarget.value);
        const form = event.currentTarget.form;
        if (form) submit(form);
      }}
      className={cn(
        "h-11 w-full rounded-md border border-input bg-background px-3 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        "focus:ring-offset-background sm:w-auto",
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          sorted by {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The route's `aria-live` region. Rendered before results, since a live region created with
 * its content announces nothing. `aria-atomic="false"` reads only the changed sentence.
 */
export function ResultsRegion({
  announcement,
  loadingAnnouncement,
  children,
}: {
  announcement: string;
  loadingAnnouncement: string;
  children: React.ReactNode;
}) {
  const { pending } = useFilterContext();

  return (
    <section aria-live="polite" aria-atomic="false" aria-busy={pending} aria-label="Results">
      <p className="sr-only">{pending ? loadingAnnouncement : announcement}</p>
      <div className={cn(pending && "opacity-60 transition-opacity motion-reduce:transition-none")}>
        {children}
      </div>
    </section>
  );
}

/**
 * Collapsible facet group, so hundreds of tag checkboxes aren't all in the tab order
 * (WCAG 2.4.1).
 *
 * `<details>` removes collapsed contents from the tab order but keeps them in the form, so
 * checked values still submit. Open state is seeded from the server and never auto-closes
 * (e.g. when the last tag is unticked).
 */
export function FacetDisclosure({
  legend,
  selectedCount,
  defaultOpen,
  children,
}: {
  legend: string;
  selectedCount: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group"
    >
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-1",
          "text-xs font-semibold uppercase tracking-wide text-muted-foreground",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex-1">{legend}</span>
        {selectedCount > 0 ? (
          <span className="tabular rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
            {selectedCount}
            <span className="sr-only"> selected</span>
          </span>
        ) : null}
      </summary>
      {children}
    </details>
  );
}

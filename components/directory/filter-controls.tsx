"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The client half of the directory filters — and it is deliberately the *only* client half.
 *
 * WHY THESE ARE REAL FORM CONTROLS INSIDE A REAL `<form method="get">`
 * --------------------------------------------------------------------
 * A GET form serialises exactly the URL shape `parseDirectoryFilters` reads: repeated
 * `?cost=free&cost=paid`, one `?q=`, one `?sort=`. So the filters work with the JavaScript
 * bundle removed, the browser's own back and forward work, and every filtered view is a
 * pasteable URL. `docs/design/wireframes/02-directory.txt` requires that last property and
 * `states.md` §2.1 depends on it: "getting back is never more than one click, and the
 * browser back button also works ... this is the reason the filters are URL state and not
 * component state."
 *
 * With JavaScript, `submit()` intercepts and does a soft `router.push` of the same URL the
 * form would have produced, inside a transition, so the results swap without a full document
 * load and the reader keeps their scroll position.
 *
 * WHY THE PENDING STATE LIVES IN A CONTEXT
 * ----------------------------------------
 * Shell handoff §10.1 wants one `aria-live` region per route carrying `aria-busy` while the
 * new results are in flight. The transition that knows about "in flight" is started by the
 * filter controls; the region that must report it wraps the results, which are a Server
 * Component. A context provider that renders server children solves it without dragging the
 * result list across the client boundary.
 *
 * Focus is never moved on a filter change (shell handoff §10.1) — the reader is still in the
 * filter bar and the count is announced to them where they are.
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
 * Build the URL a `<form method="get">` submission would have produced, minus the empty
 * values a browser would otherwise append as bare `?q=&sort=`.
 *
 * `FormData` only carries checked checkboxes and non-disabled fields, which is precisely the
 * active filter set. Nothing is read from component state, so the DOM cannot disagree with
 * the URL.
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
      // `scroll: false`: the reader is in the filter bar and the new count is announced to
      // them there. Yanking the viewport to the top would lose their place in a long facet
      // list for no benefit.
      startTransition(() => router.push(href, { scroll: false }));
    },
    [router],
  );

  const value = React.useMemo(() => ({ pending, submit }), [pending, submit]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

/**
 * The form element itself. `action` is the route the filters belong to, so the no-JavaScript
 * submission and the `router.push` land on the same path.
 */
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
 * The name field.
 *
 * Controlled, with the URL as the source of truth: local state gives the reader their
 * keystrokes immediately, and the effect re-syncs whenever the address changes for a reason
 * this field did not cause — the `name:` chip being removed, "clear all", the back button.
 * An uncontrolled `defaultValue` would leave the old text sitting in the box after the filter
 * it represents had been dropped, which reads as a filter that refuses to clear.
 *
 * It submits on Enter, never per keystroke: a push per character would fill the history stack
 * and break the back button this whole route is built around.
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
 * A facet checkbox.
 *
 * Local state mirrors the prop rather than replacing it: the click gives instant feedback
 * while the transition runs, and the effect re-syncs whenever the URL changes for a reason
 * this control did not cause — the browser back button, a removed chip, "clear all". Without
 * the effect, back-navigating would leave a box ticked for a filter that is no longer
 * applied, which is the single most misleading thing a filter panel can do.
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
  /** `null` when the facet-count query has nothing for this value — `states.md` §2.5. */
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

/**
 * A facet radio. Used for `category`, which `parseDirectoryFilters` reads as a single value —
 * rendering it as checkboxes would offer a multi-select the query layer cannot honour.
 */
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

/**
 * The sort control. A native `<select>`, not the Radix primitive: it must submit inside a
 * GET form with no JavaScript, and the platform control already gives keyboard operation,
 * screen-reader support and the mobile picker for free.
 */
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
 * The one `aria-live` region on the route (shell handoff §10.1).
 *
 * It is in the DOM before the results are, which is the whole point: a live region created
 * at the same moment as its content announces nothing. `aria-atomic="false"` so only the
 * changed sentence is read, not the entire result list.
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

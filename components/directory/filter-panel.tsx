import Link from "next/link";

import { ConfidenceChip } from "@/components/confidence-chip";
import { methodologyAnchorHref } from "@/components/layout/methodology-anchor";
import type { ConfidenceLevel } from "@/db/schema";
import { cn } from "@/lib/utils";

import { FacetCheckbox, FacetRadio, FilterForm } from "./filter-controls";

/**
 * The facet panel. One Server Component, rendered twice: as the `md:` sidebar and inside the
 * mobile sheet. Only the leaves are client components, which is the whole reason this file is
 * server-side — every label, count and legend is computed on the server and shipped as HTML.
 *
 * `idPrefix` exists because both copies are in the DOM at once (one is `hidden`, the other is
 * `md:hidden`) and two `<label for>` targets with the same id would point the sheet's label at
 * the sidebar's checkbox.
 *
 * `hidden` mirrors the parts of the filter tuple this form does not own — `q` and `sort` live
 * in the toolbar. Without the mirror, changing a checkbox would silently discard the query.
 */

export interface FacetOption {
  value: string;
  label: string;
  /**
   * `null` renders no count at all rather than a zero (`states.md` §2.5: "facet checkboxes
   * render without their counts rather than not rendering"). A zero we have not measured is
   * a false statement, which is the same rule the home page counts follow.
   */
  count: number | null;
  checked: boolean;
  /** The confidence group renders the chip itself, so the filter matches the card. */
  confidence?: ConfidenceLevel;
}

export interface FacetGroup {
  id: string;
  legend: string;
  /** `category` is single-valued in `parseDirectoryFilters`, so it renders as radios. */
  kind: "checkbox" | "radio";
  /** The `searchParams` key, e.g. `cost`. */
  name: string;
  options: FacetOption[];
  note?: string;
  /** Long vocabularies (tags, input types) scroll inside the group. */
  scroll?: boolean;
}

export function FilterPanel({
  action,
  idPrefix,
  groups,
  hidden,
  footer,
  className,
  countsNote,
}: {
  action: string;
  idPrefix: string;
  groups: readonly FacetGroup[];
  hidden: readonly { name: string; value: string }[];
  footer?: React.ReactNode;
  className?: string;
  /** Rendered once at the top of the panel when facet counts could not be read. */
  countsNote?: string;
}) {
  return (
    <FilterForm action={action} className={cn("flex min-h-0 flex-col", className)}>
      {hidden.map((pair, index) => (
        <input key={`${pair.name}-${pair.value}-${index}`} type="hidden" {...pair} />
      ))}

      {countsNote ? (
        <p className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {countsNote}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
        {groups.map((group) => (
          <fieldset key={group.id}>
            <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.legend}
            </legend>

            {group.note ? (
              <p className="mb-1.5 text-xs leading-relaxed text-muted-foreground">{group.note}</p>
            ) : null}

            {group.id === "confidence" ? (
              <p className="mb-1.5 text-xs text-muted-foreground">
                <Link
                  href={methodologyAnchorHref("verified")}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  What each level means
                </Link>
              </p>
            ) : null}

            <div className={cn(group.scroll && "max-h-64 overflow-y-auto pr-1")}>
              {group.options.map((option) => {
                const id = `${idPrefix}-${group.id}-${option.value || "any"}`;
                const label = (
                  <span className="flex items-center gap-2">
                    {option.confidence ? (
                      <ConfidenceChip level={option.confidence} showMeter={false} />
                    ) : null}
                    <span className="truncate">{option.label}</span>
                  </span>
                );

                return group.kind === "radio" ? (
                  <FacetRadio
                    key={option.value || "any"}
                    id={id}
                    name={group.name}
                    value={option.value}
                    checked={option.checked}
                    count={option.count}
                  >
                    {label}
                  </FacetRadio>
                ) : (
                  <FacetCheckbox
                    key={option.value}
                    id={id}
                    name={group.name}
                    value={option.value}
                    checked={option.checked}
                    count={option.count}
                  >
                    {label}
                  </FacetCheckbox>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {/*
        The no-JavaScript path. With the bundle running, every control pushes on change and
        this is never needed; without it, the form still has to be submittable from the
        keyboard. It is `sr-only` rather than absent because a control nobody can reach is
        the same as no control at all.
      */}
      <button
        type="submit"
        className="sr-only focus:not-sr-only focus:mt-4 focus:inline-flex focus:h-11 focus:items-center focus:rounded-md focus:bg-primary focus:px-4 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        apply filters
      </button>

      {footer}
    </FilterForm>
  );
}

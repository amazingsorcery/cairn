import Link from "next/link";

import { ConfidenceChip } from "@/components/confidence-chip";
import { methodologyAnchorHref } from "@/components/layout/methodology-anchor";
import type { ConfidenceLevel } from "@/db/schema";
import { cn } from "@/lib/utils";

import { FacetCheckbox, FacetDisclosure, FacetRadio, FilterForm } from "./filter-controls";

/**
 * Facet panel, rendered twice (sidebar and mobile sheet). `idPrefix` keeps label ids unique
 * across both copies. `hidden` mirrors `q` and `sort` from the toolbar so they survive a submit.
 */

export interface FacetOption {
  value: string;
  label: string;
  /** `null` (counts unavailable) renders the option without a count, never as zero. */
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
  /**
   * Collapse behind `<details>` unless something is selected, so long vocabularies cost one
   * tab stop. Inputs stay in the form and still submit when collapsed.
   */
  collapsible?: boolean;
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
        <p className="border-border bg-muted text-muted-foreground mb-4 rounded-md border px-3 py-2 text-xs">
          {countsNote}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
        {groups.map((group) => {
          const selectedCount = group.options.filter(
            (option) => option.checked && option.value !== "",
          ).length;

          const body = (
            <>
              {group.note ? (
                <p className="text-muted-foreground mb-1.5 text-xs leading-relaxed">{group.note}</p>
              ) : null}

              {group.id === "confidence" ? (
                <p className="text-muted-foreground mb-1.5 text-xs">
                  <Link
                    href={methodologyAnchorHref("verified")}
                    className="hover:text-foreground underline underline-offset-4"
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
                      {/*
                      Hidden from screen readers: the chip's own SR text describes an entry,
                      which is wrong for a filter option. The label beside it is the name.
                    */}
                      {option.confidence ? (
                        <span aria-hidden="true" className="inline-flex">
                          <ConfidenceChip level={option.confidence} showMeter={false} />
                        </span>
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
            </>
          );

          // Always a labelled fieldset; collapsible groups move the visible legend into `<details>`.
          return (
            <fieldset key={group.id}>
              {group.collapsible ? (
                <>
                  <legend className="sr-only">{group.legend}</legend>
                  <FacetDisclosure
                    legend={group.legend}
                    selectedCount={selectedCount}
                    defaultOpen={selectedCount > 0}
                  >
                    {body}
                  </FacetDisclosure>
                </>
              ) : (
                <>
                  <legend className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
                    {group.legend}
                  </legend>
                  {body}
                </>
              )}
            </fieldset>
          );
        })}
      </div>

      {/* No-JS submit path; visually hidden until focused. */}
      <button
        type="submit"
        className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:mt-4 focus:inline-flex focus:h-11 focus:items-center focus:rounded-md focus:px-4 focus:text-sm focus:font-medium"
      >
        apply filters
      </button>

      {footer}
    </FilterForm>
  );
}

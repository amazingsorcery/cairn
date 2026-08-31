import Link from "next/link";
import { Laptop, ExternalLink } from "lucide-react";
import type * as React from "react";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import {
  DATA_HANDLING_DETAIL,
  DATA_HANDLING_LABEL,
  type ToolbenchEntry,
} from "@/lib/toolbench/registry";
import { cn } from "@/lib/utils";

/**
 * The frame every Toolbench page is built in.
 *
 * The four sections below are required props, not optional slots, because the product brief
 * makes them the definition of a finished tool: its own route, an explanation of the
 * technique **and its limits**, a worked example, and a link to the playbook that uses it.
 * Making `technique`, `limits` and `workedExample` mandatory means a tool cannot ship
 * half-built without the type error being the first thing its author sees.
 *
 * Layout follows `docs/frontend/HANDOFF-shell.md` section 3: an 80rem page container, and
 * prose in a 68ch column. The interactive part is allowed the full width because a
 * conversion table with six formats does not fit in a reading measure; the writing around it
 * is not.
 */

export interface ToolPageProps {
  readonly entry: ToolbenchEntry;
  /** The interactive tool. Almost always a client component. */
  readonly children: React.ReactNode;
  /** How the technique works, in the reader's terms rather than the implementation's. */
  readonly technique: React.ReactNode;
  /** What a negative result means, and what would make the answer wrong. */
  readonly limits: React.ReactNode;
  /** A worked example the reader can follow through with the tool above. */
  readonly workedExample: React.ReactNode;
}

function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className={cn("mt-12", className)}>
      <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-3 space-y-4 text-base leading-relaxed text-foreground-secondary">
        {children}
      </div>
    </section>
  );
}

/**
 * The privacy claim, rendered at the top of the page rather than the bottom.
 *
 * Product brief section 2a: client-side operation "must be *stated on each tool page*, not
 * merely true. A journalist deciding whether to upload a source's photograph needs to read
 * that it stays in their browser." A badge in a footer does not do that job.
 */
export function DataHandlingNotice({ entry }: { entry: ToolbenchEntry }) {
  const inBrowser = entry.dataHandling === "inBrowser";
  return (
    <div
      className={cn(
        "mt-6 flex items-start gap-3 rounded-lg border p-4 text-sm",
        inBrowser ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10",
      )}
    >
      {inBrowser ? (
        <Laptop className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <ExternalLink className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      )}
      <div>
        <p className="font-medium text-foreground">{DATA_HANDLING_LABEL[entry.dataHandling]}</p>
        <p className="mt-1 leading-relaxed text-foreground-secondary">
          {DATA_HANDLING_DETAIL[entry.dataHandling]}
        </p>
      </div>
    </div>
  );
}

export function ToolPage({ entry, children, technique, limits, workedExample }: ToolPageProps) {
  return (
    <div className="mx-auto w-full max-w-[80rem] px-4 py-10 md:px-6 md:py-14">
      <Breadcrumb
        items={[
          { label: "Toolbench", href: "/toolbench" },
          { label: entry.name },
        ]}
      />

      <header className="mt-6 max-w-[68ch]">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{entry.name}</h1>
        <p className="mt-3 text-lg text-foreground-secondary">{entry.summary}</p>
        <DataHandlingNotice entry={entry} />
      </header>

      <section aria-labelledby="tool-heading" className="mt-10">
        <h2 id="tool-heading" className="sr-only">
          The tool
        </h2>
        {children}
      </section>

      <div className="max-w-[68ch]">
        <Section id="technique" title="How this works">
          {technique}
        </Section>

        <Section id="limits" title="What would make this answer wrong">
          {limits}
        </Section>

        <Section id="example" title="Worked example">
          {workedExample}
        </Section>

        <Section id="playbook" title="Where this fits">
          <p>{entry.playbook.step}</p>
          <p>
            <Link
              href={`/playbooks/${entry.playbook.slug}`}
              className="font-medium text-primary underline underline-offset-4"
            >
              Read the {entry.playbook.title} playbook
            </Link>
            .
          </p>
        </Section>
      </div>
    </div>
  );
}

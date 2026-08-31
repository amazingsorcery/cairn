import Link from "next/link";
import { CircleCheckBig } from "lucide-react";

import { Markdown } from "@/components/content/markdown";
import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import type { PlaybookStepDetail } from "@/lib/queries/playbooks";

/**
 * One numbered step, rendered on the server.
 *
 * ANCHORS. The heading carries `id="step-<n>"` where `n` is 1-based (wireframe 06: "stable
 * across reorder only within a published version"). A workspace checklist item links back
 * here, so the identifier is part of the product's contract and not a styling detail.
 * `tabIndex={-1}` means following the anchor moves focus to the heading rather than leaving
 * a keyboard reader stranded in the step index.
 *
 * TOOLS FOR THIS STEP carry their confidence chip. A methodology that cites an uncertain
 * entry has to say so at the point of use, not only on the entry's own page — that is
 * architecture HANDOFF §9.1 applied where it actually matters: mid-method, when the reader
 * is deciding whether to rely on the tool.
 *
 * "HOW YOU KNOW THIS STEP IS DONE" uses `--success-surface` with an icon AND the heading
 * text. Never a bare green tick: dark `--success` and `--warning` differ by 1.04:1 in
 * luminance and sit on the red-green axis (`docs/design/colour.md` §5).
 */

export interface PlaybookStepProps {
  step: PlaybookStepDetail;
  /** 1-based position, which is also the anchor number. */
  position: number;
}

export function PlaybookStep({ step, position }: PlaybookStepProps) {
  const anchor = `step-${position}`;

  return (
    <section aria-labelledby={anchor} className="border-t border-border pt-8 first:border-t-0 first:pt-0">
      <h2
        id={anchor}
        tabIndex={-1}
        className="flex gap-3 text-xl font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
      >
        <span className="tabular text-muted-foreground">{position}</span>
        <span className="min-w-0">{step.title}</span>
      </h2>

      <div className="mt-5 max-w-[68ch]">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
          Objective
        </h3>
        <p className="mt-1.5 text-base leading-relaxed">{step.objective}</p>
      </div>

      <div className="mt-5 max-w-[68ch]">
        <Markdown className="text-base">{step.body}</Markdown>
      </div>

      {step.tools.length > 0 ? (
        <div className="mt-6 max-w-[68ch]">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
            Tools for this step
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {step.tools.map((tool) => (
              <li key={tool.slug} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link
                  href={`/tools/${tool.slug}`}
                  className="rounded-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {tool.name}
                </Link>
                <ConfidenceChipLink level={tool.confidence} showMeter={false} />
                {tool.note ? (
                  <span className="w-full text-sm text-foreground-secondary">{tool.note}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 max-w-[68ch] rounded-lg border border-success/40 bg-success-surface p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-success">
          <CircleCheckBig className="size-4" aria-hidden="true" />
          How you know this step is done
        </h3>
        <p className="mt-1.5 text-base leading-relaxed">{step.doneWhen}</p>
      </div>
    </section>
  );
}

import Link from "next/link";

import { ConfidenceChipLink } from "@/components/layout/methodology-anchor";
import { Card, CardContent } from "@/components/ui/card";
import { VerificationDate } from "@/components/verification-date";
import type { PlaybookCard as PlaybookCardData } from "@/lib/queries/playbooks";
import { PlaybookMeta } from "./playbook-meta";

/**
 * One playbook on `/playbooks`.
 *
 * No `"use client"` and no server-only import, so it is usable from both sides of the
 * boundary: the index renders it inside a client filter leaf, and nothing here needs a
 * session, a database or `lib/env`.
 *
 * Confidence and last-verified are not optional (`docs/design/states.md` §0, architecture
 * HANDOFF §9.1): there is no view of an entry in this product that omits them.
 *
 * The heading level is a prop, defaulting to `h2`, because the caller owns the document
 * outline — the same rule `CardTitle` follows. It was hardcoded to `h3` and the index renders
 * these directly under the page `h1`, so a populated list jumped h1 to h3 and skipped a
 * level. Lighthouse caught it as `heading-order`; a screen-reader user navigating by heading
 * would have experienced it as a missing section.
 */
export function PlaybookCardItem({
  playbook,
  headingLevel = 2,
}: {
  playbook: PlaybookCardData;
  /** 2 when the cards sit directly under the page `h1`; 3 when nested under a section. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <Card className="h-full transition-colors hover:border-ring motion-reduce:transition-none">
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <Heading className="text-lg font-semibold leading-tight tracking-tight">
          <Link
            href={`/playbooks/${playbook.slug}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {playbook.title}
          </Link>
        </Heading>

        <p className="text-sm leading-relaxed text-foreground-secondary">{playbook.summary}</p>

        <PlaybookMeta
          difficulty={playbook.difficulty}
          stepCount={playbook.stepCount}
          estimatedMinutes={playbook.estimatedMinutes}
          categoryName={playbook.categoryName}
        />

        <div className="mt-auto flex flex-col gap-1.5 pt-2">
          <ConfidenceChipLink level={playbook.confidence} className="self-start" />
          <VerificationDate lastVerifiedAt={playbook.lastVerifiedAt} />
        </div>
      </CardContent>
    </Card>
  );
}

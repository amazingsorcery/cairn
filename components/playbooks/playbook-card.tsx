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
 */
export function PlaybookCardItem({ playbook }: { playbook: PlaybookCardData }) {
  return (
    <Card className="h-full transition-colors hover:border-ring motion-reduce:transition-none">
      <CardContent className="flex h-full flex-col gap-3 p-5">
        <h3 className="text-lg font-semibold leading-tight tracking-tight">
          <Link
            href={`/playbooks/${playbook.slug}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {playbook.title}
          </Link>
        </h3>

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

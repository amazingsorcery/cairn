import { Badge } from "@/components/ui/badge";
import type { DifficultyLevel } from "@/db/schema";

/**
 * The meta chip row: difficulty, step count, estimated minutes, category.
 *
 * `~<n> min` is an estimate and reads as one. It is never rendered as a promise ("takes
 * 120 minutes") because a method's duration depends entirely on what the evidence turns
 * out to be, and overstating certainty is the one thing this product may not do.
 */

const DIFFICULTY_LABEL: Record<DifficultyLevel, string> = {
  beginner: "beginner",
  intermediate: "intermediate",
  advanced: "advanced",
};

export interface PlaybookMetaProps {
  difficulty: DifficultyLevel;
  stepCount: number;
  estimatedMinutes: number;
  categoryName?: string;
}

export function PlaybookMeta({
  difficulty,
  stepCount,
  estimatedMinutes,
  categoryName,
}: PlaybookMetaProps) {
  return (
    <ul className="flex flex-wrap items-center gap-2">
      <li>
        <Badge variant="outline">{DIFFICULTY_LABEL[difficulty]}</Badge>
      </li>
      <li>
        <Badge variant="muted" className="tabular">
          {stepCount === 1 ? "1 step" : `${stepCount} steps`}
        </Badge>
      </li>
      <li>
        <Badge variant="muted" className="tabular">
          <span className="sr-only">estimated </span>~{estimatedMinutes} min
        </Badge>
      </li>
      {categoryName ? (
        <li>
          <Badge variant="muted">{categoryName.toLowerCase()}</Badge>
        </li>
      ) : null}
    </ul>
  );
}

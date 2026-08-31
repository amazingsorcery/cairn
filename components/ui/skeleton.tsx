import { cn } from "@/lib/utils";

/**
 * Loading placeholder. `aria-hidden` because the live region announcing "Loading…" is the
 * accessible signal — a screen reader reading out a grid of empty boxes is worse than
 * silence. Animation is suppressed under prefers-reduced-motion.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

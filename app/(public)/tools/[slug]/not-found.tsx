import NotFound from "@/app/not-found";

/**
 * Unknown or draft tool. Reuses the global 404 so the two cases look identical and can't
 * reveal unpublished entries. `getToolBySlug` returns null for drafts.
 */
export default function ToolNotFound() {
  return <NotFound />;
}

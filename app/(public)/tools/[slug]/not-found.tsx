import NotFound from "@/app/not-found";

/**
 * An unknown slug, **or a draft one**.
 *
 * `states.md` §1.2: "For a draft or removed entry the 404 is the same page. It must not
 * distinguish 'never existed' from 'not published' — that would confirm the existence of
 * unpublished rows." Reusing the global component rather than restating the copy makes that
 * structurally true: there is one page, so the two cases cannot drift apart.
 *
 * The query layer does the actual work — `getToolBySlug` filters `status = 'published'` and
 * returns null for a draft, which the route turns into `notFound()` (architecture HANDOFF §7,
 * QA assertion 3).
 */
export default function ToolNotFound() {
  return <NotFound />;
}

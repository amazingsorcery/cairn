import NotFound from "@/app/not-found";

/**
 * An unknown tag slug, or one that only draft entries carry.
 *
 * Same page as the global 404, by reuse rather than by restating the copy — `states.md` §1.2
 * requires that "not published" and "never existed" are indistinguishable, and a second copy
 * of the words is a second thing that can drift.
 */
export default function TagNotFound() {
  return <NotFound />;
}
